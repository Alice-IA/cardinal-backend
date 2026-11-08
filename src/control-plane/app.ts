/**
 * Control plane Fastify. Convive con la app Express de auth durante la
 * migración: `tests/regression-auth.test.ts` ejecuta los 6 tests de auth
 * existentes contra esta app con `inject()`.
 *
 * Incluye ya la API interna que consume cardinal-gateway (`/internal/*`),
 * autenticada con `X-Internal-Token` y fuera del OpenAPI público. El resto
 * (`/api/*`, `/docs/json`) sigue en 501 hasta la sesión del control plane.
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { registerInternalRoutes } from '../modules/internal/internal.routes';
import type { TicketDeps } from '../modules/tickets/ticket.service';
import { AppError } from '../utils/errors';

/**
 * Códigos estables para errores 4xx que genera el propio Fastify (prefijo
 * `FST_`). Nunca se reenvía el código interno del framework al cliente.
 */
const FRAMEWORK_CODES_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
};

function frameworkErrorCode(statusCode: number, code: string): string {
  // Errores de parseo/validación del body: el contrato del proyecto usa
  // VALIDATION_ERROR para todo body inválido, venga de Zod o de Fastify.
  if (
    code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    code === 'FST_ERR_VALIDATION'
  ) {
    return 'VALIDATION_ERROR';
  }

  return (
    FRAMEWORK_CODES_BY_STATUS[statusCode] ??
    (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST')
  );
}

interface ErrorLike {
  statusCode?: unknown;
  code?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : {};
}

function isFrameworkError(
  error: unknown,
): error is FastifyError & { statusCode: number; code: string } {
  const candidate = asErrorLike(error);
  return (
    typeof candidate.statusCode === 'number' &&
    candidate.statusCode >= 400 &&
    candidate.statusCode <= 599 &&
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('FST_')
  );
}

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

  // La API interna solo acepta JSON. Fastify trae un parser `text/plain` por
  // defecto; si se deja, un POST text/plain llega al handler (401/400) en vez
  // de rechazarse como media type no soportado (415).
  app.removeContentTypeParser('text/plain');

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

    // Errores del framework (FST_*): respetar su statusCode. Los 4xx son culpa
    // del cliente y no se loguean como error. Los 5xx sí (son fallo nuestro).
    if (isFrameworkError(error)) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, 'error de framework');
      }

      reply.code(error.statusCode).send({
        error: {
          code: frameworkErrorCode(error.statusCode, error.code),
          message:
            error.statusCode >= 500
              ? 'Error interno del servidor'
              : error.message || 'Solicitud inválida',
        },
      });
      return;
    }

    // 4xx con un code que no reconocemos: 400 genérico, sin filtrar detalles.
    const statusCode = asErrorLike(error).statusCode;
    if (
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode <= 499
    ) {
      reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'Datos inválidos' },
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
