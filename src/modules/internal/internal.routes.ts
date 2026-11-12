import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { requireInternalToken } from '../../middlewares/internal-auth.middleware';
import { resolvePrimaryRoute, resolveRoute } from '../agents/ownership.service';
import { onManagerCallback, retryProvision, type ProvisionDeps } from '../provision/provision.service';
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

/**
 * Callback del Sandbox Manager. `jobId` es el UUID que generó el backend y el
 * manager devuelve tal cual (decisión A).
 *
 * `port` llega como número; `z.coerce.number` tolera un JSON que lo traiga
 * como string sin relajar el rango.
 */
const provisionCallbackBody = z.object({
  jobId: z.uuid('jobId debe ser un UUID'),
  ok: z.boolean(),
  containerName: z.string().min(1).optional(),
  internalHost: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  transport: z.enum(['ws', 'wss']).optional(),
  containerId: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  message: z.string().optional(),
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
  /**
   * Dependencias del bloque de aprovisionamiento. Opcionales para que los
   * tests de las rutas anteriores puedan construir el control plane sin
   * manager; si faltan, las rutas de provisión responden 503 (nunca 404).
   */
  provisionDeps?: ProvisionDeps;
}

function requireProvisionDeps(options: InternalRoutesOptions): ProvisionDeps {
  if (!options.provisionDeps) {
    throw new AppError('INTERNAL_ERROR', 503, 'Aprovisionamiento no configurado');
  }
  return options.provisionDeps;
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

  // ── Aprovisionamiento ───────────────────────────────────────────────────
  // `/internal/provision/ready` es de uso EXCLUSIVO del Sandbox Manager, pero
  // comparte el MISMO INTERNAL_TOKEN que el resto de /internal/*. El gateway
  // no debe llamarlo.
  app.post(
    '/internal/provision/ready',
    { preHandler: requireInternalToken },
    async (request) => {
      const deps = requireProvisionDeps(options);

      const parsed = provisionCallbackBody.safeParse(request.body);
      if (!parsed.success) throw validationError(zodDetails(parsed.error));

      // Idempotente: un jobId desconocido o ya cerrado responde 200 sin hacer
      // nada (el manager puede reintentar el callback).
      await onManagerCallback(parsed.data, deps);
      return { ok: true };
    },
  );

  // Proxy de diagnóstico. El backend autentica al manager con su propio
  // X-Internal-Token; el token del llamante no se reenvía.
  app.get(
    '/internal/provision/:jobId',
    { preHandler: requireInternalToken },
    async (request) => {
      const deps = requireProvisionDeps(options);
      const { jobId } = request.params as { jobId: string };

      try {
        return await deps.manager.get(jobId);
      } catch (error) {
        // El cliente del manager no incluye token en sus errores.
        request.log.error({ err: error, jobId }, 'fallo al consultar el manager');
        throw new AppError('UPSTREAM_ERROR', 502, 'El manager no respondió');
      }
    },
  );

  // Decisión C: al agotar los reintentos del agente, este endpoint crea un
  // jobId nuevo y regenera el token (el contenedor se recrea).
  app.post(
    '/internal/provision/:jobId/retry',
    { preHandler: requireInternalToken },
    async (request, reply) => {
      const deps = requireProvisionDeps(options);
      const { jobId } = request.params as { jobId: string };

      const result = await retryProvision(jobId, deps);
      reply.code(202);
      return result;
    },
  );
}
