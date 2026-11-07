/**
 * Gateway de agentes: proxy HTTP y WebSocket hacia el app-server del
 * contenedor, con autenticación de usuario y de contenedor.
 *
 * FASE 0a: solo contrato. `buildGatewayApp` devuelve una app Fastify vacía que
 * responde 501, para que los tests fallen por comportamiento y no por import.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { RouteResolution } from '../modules/agents/ownership.service';

/** Ruta WS del agente. El test fija esta forma; el control plane usa `/api`. */
export const GATEWAY_WS_PATH = '/v1/agents/:agentId/ws';
export const GATEWAY_AGENTS_PATH = '/v1/agents';

export interface GatewayOptions {
  /** Por defecto, el `resolveRoute` real (scoped por usuario). */
  resolveRoute?: (userId: string, agentId: string) => Promise<RouteResolution | null>;
  /** Verifica el access token del usuario y devuelve su id. */
  verifyAccessToken?: (token: string) => Promise<{ userId: string }>;
  /** Lee el secreto compartido del app-server desde la ruta del contenedor. */
  getContainerSecret?: (containerId: string) => Promise<string>;
  /** Timeout del proxy HTTP. En tests se baja a ~100 ms. */
  upstreamTimeoutMs?: number;
  now?: () => number;
}

export function buildGatewayApp(_options: GatewayOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(501).send({
      error: { code: 'NOT_IMPLEMENTED', message: 'not implemented: gateway' },
    }),
  );

  return app;
}
