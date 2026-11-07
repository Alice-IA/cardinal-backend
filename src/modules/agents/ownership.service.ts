import { prisma } from '../../config/prisma';

/**
 * Dominio de ownership y resolución de rutas a contenedores.
 *
 * Esta función NO valida tokens: recibe IDs ya autenticados por el control
 * plane/gateway. La frontera de seguridad que sí aplica aquí es el filtro
 * `user_id` en la query, para que un usuario nunca resuelva un agente ajeno.
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
 * Una sola query con join agents → containers → nodes.
 *
 * Precedencia contractual:
 * 1. Sin fila (agente inexistente o de otro user_id) → null.
 * 2. Contenedor que no está running → SANDBOX_NOT_READY.
 * 3. Nodo ausente o down → NODE_UNAVAILABLE.
 * 4. En otro caso → ruta interna.
 *
 * El filtro `a.user_id` va en el WHERE: un agente ajeno con contenedor en
 * `creating` no produce error, produce null (no revela la existencia).
 */
export async function resolveRoute(
  userId: string,
  agentId: string,
): Promise<RouteResolution | null> {
  const rows = await prisma.$queryRaw<RouteRow[]>`
    SELECT
      n.host            AS host,
      n.port            AS port,
      n.id              AS node_id,
      n.status          AS node_status,
      c.status          AS container_status
    FROM agents a
    INNER JOIN containers c ON c.id = a.container_id
    LEFT JOIN nodes n ON n.id = c.node_id
    WHERE a.agent_id = ${agentId}
      AND a.user_id = ${userId}::uuid
    LIMIT 1
  `;

  const row = rows[0];
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
