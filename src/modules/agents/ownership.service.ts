import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../utils/logger';

/**
 * Dominio de ownership y resolución de rutas a contenedores.
 *
 * Estas funciones NO validan tokens: reciben IDs ya autenticados por el
 * control plane/gateway. La frontera de seguridad que sí aplica aquí es el
 * filtro `user_id` en la query, para que un usuario nunca resuelva un agente
 * ajeno.
 */

export interface ResolvedRoute {
  host: string;
  port: number;
  nodeId: string;
}

export type RouteFailure =
  | { error: 'SANDBOX_NOT_READY' }
  | { error: 'NODE_UNAVAILABLE' };

export type RouteResolution = ResolvedRoute | RouteFailure;

/** Mismo resultado que `resolveRoute`: ruta, motivo de fallo o `null`. */
export type RouteResult = RouteResolution | null;

export interface PrimaryAgent {
  agentId: string;
  containerId: string;
}

interface RouteRow {
  host: string | null;
  port: number | null;
  node_id: string | null;
  node_status: string | null;
  container_status: string;
}

/**
 * SELECT + JOIN compartidos por `resolveRoute` y `resolvePrimaryRoute`.
 * El WHERE (y el ORDER/LIMIT) es lo único que cambia entre ambas: así no
 * divergen los filtros de status del contenedor ni del nodo.
 */
const ROUTE_SELECT = Prisma.sql`
  SELECT
    n.host            AS host,
    n.port            AS port,
    n.id              AS node_id,
    n.status          AS node_status,
    c.status          AS container_status
  FROM agents a
  INNER JOIN containers c ON c.id = a.container_id
  LEFT JOIN nodes n ON n.id = c.node_id
`;

/**
 * Precedencia contractual (idéntica para las dos resoluciones):
 * 1. Sin fila → null.
 * 2. Contenedor que no está running → SANDBOX_NOT_READY.
 * 3. Nodo ausente o down → NODE_UNAVAILABLE.
 * 4. En otro caso → ruta interna.
 */
function toResolution(row: RouteRow | undefined): RouteResolution | null {
  if (!row) return null;

  if (row.container_status !== 'running') {
    return { error: 'SANDBOX_NOT_READY' };
  }

  if (
    row.node_id === null ||
    row.host === null ||
    row.port === null ||
    row.node_status !== 'up'
  ) {
    return { error: 'NODE_UNAVAILABLE' };
  }

  return {
    host: row.host,
    port: row.port,
    nodeId: row.node_id,
  };
}

/**
 * Query base de enrutamiento. `agentId` presente resuelve un agente concreto
 * (y filtra por `a.user_id`); ausente resuelve el primario del usuario
 * (filtrando por `c.user_id` + `a.is_primary`).
 */
async function queryRouteRows(userId: string, agentId?: string): Promise<RouteRow[]> {
  const filter =
    agentId === undefined
      ? Prisma.sql`
          WHERE c.user_id = ${userId}::uuid
            AND a.is_primary = true
          ORDER BY a.created_at ASC
          LIMIT 2
        `
      : Prisma.sql`
          WHERE a.agent_id = ${agentId}
            AND a.user_id = ${userId}::uuid
          LIMIT 1
        `;

  return prisma.$queryRaw<RouteRow[]>(Prisma.sql`${ROUTE_SELECT} ${filter}`);
}

/**
 * Resuelve un agente concreto. El filtro `a.user_id` va en el WHERE: un
 * agente ajeno con contenedor en `creating` no produce error, produce null
 * (no revela la existencia).
 */
export async function resolveRoute(
  userId: string,
  agentId: string,
): Promise<RouteResolution | null> {
  const rows = await queryRouteRows(userId, agentId);
  return toResolution(rows[0]);
}

/**
 * Resuelve el agente primario del usuario (handshake WS solo con Bearer y
 * `GET /v1/agents`, donde el gateway no recibe `agentId`).
 *
 * `agents_one_primary_per_container` debería garantizar un único primario.
 * Si por datos corruptos aparecen dos, se queda con el `created_at` más
 * antiguo y avisa en el log; no se lanza.
 */
export async function resolvePrimaryRoute(userId: string): Promise<RouteResult> {
  const rows = await queryRouteRows(userId);

  if (rows.length > 1) {
    logger.warn(
      { userId, primaries: rows.length },
      'múltiples agentes primarios para el usuario; se usa el más antiguo',
    );
  }

  return toResolution(rows[0]);
}

/**
 * Lista únicamente los agentes primarios del usuario. Los subagentes
 * (`is_primary = false`) no aparecen en el control plane.
 */
export async function listPrimaryAgents(userId: string): Promise<PrimaryAgent[]> {
  return prisma.agent.findMany({
    where: {
      userId,
      isPrimary: true,
    },
    select: {
      agentId: true,
      containerId: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });
}
