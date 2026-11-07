/**
 * Control plane Fastify. Convive con la app Express de auth durante la
 * migración: `tests/regression-auth.test.ts` ejecuta los 6 tests de auth
 * existentes contra esta app con `inject()`.
 *
 * Incluye ya la API interna que consume cardinal-gateway (`/internal/*`),
 * autenticada con `X-Internal-Token` y fuera del OpenAPI público. El resto
 * (`/api/*`, `/docs/json`) sigue en 501 hasta la sesión del control plane.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerInternalRoutes } from '../modules/internal/internal.routes';
import type { TicketDeps } from '../modules/tickets/ticket.service';
import { AppError } from '../utils/errors';

export interface ControlPlaneOptions {
  /**
   * Dependencias de `consumeTicket`. Son obligatorias a propósito: un default
   * con store en memoria arrancaría en producción sin deduplicar entre
   * réplicas, y el mismo ticket podría canjearse dos veces. Un fallo de wiring
   * debe verse al construir la app, no cuando alguien reutiliza un ticket.
   */
  ticketDeps: TicketDeps;
  /** Logger ya construido (p. ej. pino); desactivado por defecto. */
  logger?: FastifyServerOptions['loggerInstance'];
}

export function buildControlPlaneApp(options: ControlPlaneOptions): FastifyInstance {
  const app = Fastify(
    options.logger ? { loggerInstance: options.logger } : { logger: false },
  );

  // Único punto de salida de errores del control plane: mismo shape que la app
  // Express, { error: { code, message, details? } }.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    request.log.error({ err: error }, 'error no controlado');
    reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' },
    });
  });

  registerInternalRoutes(app, { ticketDeps: options.ticketDeps });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(501).send({
      error: { code: 'NOT_IMPLEMENTED', message: 'not implemented: control plane' },
    }),
  );

  return app;
}
