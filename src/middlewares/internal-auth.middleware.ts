import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { internalUnauthorized } from '../utils/errors';

/**
 * Autenticación de la API interna backend → gateway.
 *
 * El gateway no comparte JWT de usuario: llama con `X-Internal-Token`, un
 * secreto estático exclusivo del backend. La comparación es en tiempo
 * constante (misma técnica que `consumeTicket`: largo primero, luego
 * `timingSafeEqual`), y el token nunca se registra en logs.
 */

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Compara dos secretos en tiempo constante; el largo se comprueba antes. */
export function secretsMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  // timingSafeEqual exige buffers del mismo largo: comparar largos primero es
  // seguro porque el largo del secreto no es información sensible.
  if (receivedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

export async function requireInternalToken(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const raw = request.headers[INTERNAL_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;

  if (typeof token !== 'string' || token.length === 0 || !secretsMatch(token, env.INTERNAL_TOKEN)) {
    throw internalUnauthorized();
  }
}
