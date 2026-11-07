import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalToken } from '../../middlewares/internal-auth.middleware';
import { resolveRoute } from '../agents/ownership.service';
import { consumeTicket, type TicketDeps } from '../tickets/ticket.service';
import { validationError, type ErrorDetail } from '../../utils/errors';

/**
 * API interna que consume cardinal-gateway por HTTP.
 *
 * El gateway NO importa código del backend: solo conoce estas dos rutas y el
 * header `X-Internal-Token`. Por eso `consumeTicket` y `resolveRoute` se
 * ejecutan una única vez, aquí.
 *
 * Estas rutas no se documentan en el OpenAPI público (`/docs/json`).
 */

const consumeBody = z.object({
  ticket: z.string().min(1, 'ticket es obligatorio'),
});

const routeBody = z.object({
  userId: z.uuid('userId debe ser un UUID'),
  agentId: z.string().min(1, 'agentId es obligatorio'),
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

  app.post('/internal/route', { preHandler: requireInternalToken }, async (request) => {
    const parsed = routeBody.safeParse(request.body);
    if (!parsed.success) throw validationError(zodDetails(parsed.error));

    const route = await resolveRoute(parsed.data.userId, parsed.data.agentId);

    // Decisión de diseño: el "no encontrado" NO es 404. Un 404 obligaría al
    // gateway a distinguir "el backend no tiene esta ruta" de "el agente no
    // existe o es de otro usuario". La petición es válida → 200 con el motivo.
    return route ?? { error: 'NOT_FOUND' };
  });
}
