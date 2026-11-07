import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { env } from '../../src/config/env';

/**
 * Access token HS256 con el mismo contrato que emite auth:
 * sub = user_id, más los claims registrados iat/exp/jti.
 *
 * Se firma directo para los tests de gateway/contract que no quieren depender
 * del endpoint de login (que en fase 0a puede seguir en Express).
 */
export async function signAccessToken(
  userId: string,
  options: { expiresInSeconds?: number; jti?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = options.expiresInSeconds ?? 15 * 60;

  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(options.jti ?? randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(env.ACCESS_TOKEN_SECRET));
}
