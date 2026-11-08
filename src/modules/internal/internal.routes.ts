import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { requireInternalToken } from '../../middlewares/internal-auth.middleware';
import { resolvePrimaryRoute, resolveRoute } from '../agents/ownership.service';
import { readCapabilityToken } from '../sandbox/credentials.service';
import { consumeTicket, type TicketDeps } from '../tickets/ticket.service';
import { TokenDecryptionError } from '../../utils/crypto';
import { AppError, validationError, type ErrorDetail } from '../../utils/errors';

/**
 * API interna que consume cardinal-gateway por HTTP.
 *
 * El gateway NO importa código del backend: solo conoce estas rutas y el
 * header `X-Internal-Token`. Por eso `consumeTicket`, `resolveRoute` y la
 * entrega de credenciales se ejecutan una única vez, aquí.
 *
 * Estas rutas no se documentan en el OpenAPI público (`/docs/json`).
 */

const consumeBody = z.object({
  ticket: z.string().min(1, 'ticket es obligatorio'),
});

const routeBody = z.object({
  userId: z.uuid('userId debe ser un UUID'),
  // Ausente = resolver el agente primario del usuario. La cadena vacía NO es
  // un centinela válido: se rechaza con 400 (min(1) dentro del optional).
  agentId: z.string().min(1, 'agentId no puede estar vacío').optional(),
});

const credentialsBody = z.object({
  sandboxId: z.string().min(1, 'sandboxId es obligatorio'),
});

function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
    issue: issue.message,
  }));
}

export interface InternalRoutesOptions {
  /** Store + secreto HMAC + reloj que necesita `consumeTicket`. */
  ticketDeps: TicketDeps;
}

export function registerInternalRoutes(
  app: FastifyInstance,
  options: InternalRoutesOptions,
): void {
  app.post(
    '/internal/tickets/consume',
    { preHandler: requireInternalToken },
    async (request) => {
      const parsed = consumeBody.safeParse(request.body);
      if (!parsed.success) throw validationError(zodDetails(parsed.error));

      // Delegación pura: no se reimplementa la validación del ticket ni se
      // añaden queries. El ticket no se loguea (ni completo ni truncado).
      return consumeTicket(parsed.data.ticket, options.ticketDeps);
    },
  );

  app.post(
    '/internal/credentials',
    { preHandler: requireInternalToken },
    async (request) => {
      const parsed = credentialsBody.safeParse(request.body);
      if (!parsed.success) throw validationError(zodDetails(parsed.error));

      try {
        const token = await readCapabilityToken(
          parsed.data.sandboxId,
          Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'),
        );

        // Única propiedad de la respuesta: el gateway la trata como string
        // opaco. El token no se loguea (ni completo ni truncado).
        return { token };
      } catch (error) {
        if (error instanceof TokenDecryptionError) {
          // El error no contiene ciphertext ni clave; el mensaje es estático.
          request.log.error({ err: error }, 'fallo al descifrar el capability token');
          throw new AppError('INTERNAL_ERROR', 500, 'Error interno del servidor');
        }
        throw error;
      }
    },
  );

  app.post('/internal/route', { preHandler: requireInternalToken }, async (request) => {
    const parsed = routeBody.safeParse(request.body);
    if (!parsed.success) throw validationError(zodDetails(parsed.error));

    const { userId, agentId } = parsed.data;

    // Sin agentId el gateway pide el primario (handshake WS / GET /v1/agents);
    // con agentId, el agente concreto del proxy HTTP.
    const route =
      agentId === undefined
        ? await resolvePrimaryRoute(userId)
        : await resolveRoute(userId, agentId);

    // Decisión de diseño: el "no encontrado" NO es 404. Un 404 obligaría al
    // gateway a distinguir "el backend no tiene esta ruta" de "el agente no
    // existe o es de otro usuario". La petición es válida → 200 con el motivo.
    return route ?? { error: 'NOT_FOUND' };
  });
}
