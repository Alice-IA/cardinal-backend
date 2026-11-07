/**
 * Control plane Fastify. Convive con la app Express de auth durante la
 * migración: `tests/regression-auth.test.ts` ejecuta los 6 tests de auth
 * existentes contra esta app con `inject()`.
 *
 * FASE 0a: solo contrato. La app devuelve 501 para que los tests estén rojos
 * por comportamiento, no por imports sin resolver.
 */

import Fastify, { type FastifyInstance } from 'fastify';

export interface ControlPlaneOptions {
  logger?: boolean;
}

export function buildControlPlaneApp(_options: ControlPlaneOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(501).send({
      error: { code: 'NOT_IMPLEMENTED', message: 'not implemented: control plane' },
    }),
  );

  return app;
}
