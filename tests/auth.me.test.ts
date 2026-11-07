import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { CREDENTIALS, api, registerAndLogin } from './helpers/client';
import { resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

const signWithSecret = async (
  secret: string,
  claims: { sub: string; expSecondsFromNow: number },
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setJti('00000000-0000-4000-8000-000000000000')
    .setIssuedAt(now - 3600)
    .setExpirationTime(now + claims.expSecondsFromNow)
    .sign(new TextEncoder().encode(secret));
};

describe('GET /auth/me', () => {
  it('devuelve el usuario con un access token válido', async () => {
    const { accessToken } = await registerAndLogin();

    const res = await api().get('/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: CREDENTIALS.email,
      name: CREDENTIALS.name,
    });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('responde 401 TOKEN_EXPIRED con un token expirado', async () => {
    const { userId } = await registerAndLogin();
    const expired = await signWithSecret(env.ACCESS_TOKEN_SECRET, {
      sub: userId,
      expSecondsFromNow: -60,
    });

    const res = await api().get('/auth/me').set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('responde 401 sin token', async () => {
    const res = await api().get('/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('responde 401 con un token firmado con otro secreto', async () => {
    const { userId } = await registerAndLogin();
    const forged = await signWithSecret(
      'un_secreto_distinto_de_al_menos_32_chars',
      { sub: userId, expSecondsFromNow: 900 },
    );

    const res = await api().get('/auth/me').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});
