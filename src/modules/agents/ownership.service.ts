/**
 * Dominio de ownership y resolución de rutas a contenedores.
 *
 * FASE 0a: solo contrato. La implementación es la fase siguiente. Los tests
 * `tests/ownership.test.ts` importan estas firmas y deben estar rojos.
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

/**
 * Resuelve la ruta interna de un agente **siempre acotada al usuario**.
 *
 * Reglas de contrato:
 * - Un agente de otro usuario devuelve `null` (nunca la fila ajena).
 * - Un agente inexistente devuelve `null`.
 * - Contenedor en creating/stopped/error → `{ error: 'SANDBOX_NOT_READY' }`.
 * - Nodo en down → `{ error: 'NODE_UNAVAILABLE' }`.
 */
export async function resolveRoute(
  _userId: string,
  _agentId: string,
): Promise<RouteResolution | null> {
  throw new Error('not implemented: resolveRoute');
}

/**
 * Lista los agentes primarios del usuario. Los subagentes (`is_primary=false`)
 * no aparecen en el control plane.
 */
export async function listPrimaryAgents(_userId: string): Promise<PrimaryAgent[]> {
  throw new Error('not implemented: listPrimaryAgents');
}
