import { beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, api, refreshCookieRaw } from './helpers/client';
import { resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

const login = (email: string, password: string) =>
  api().post('/auth/login').send({ email, password });

const decodePayload = (token: string): Record<string, unknown> => {
  const part = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
};

describe('POST /auth/login', () => {
  it('devuelve accessToken en el body y refreshToken en cookie httpOnly', async () => {
    await api().post('/auth/register').send(CREDENTIALS);

    const res = await login(CREDENTIALS.email, CREDENTIALS.password);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body).not.toHaveProperty('refreshToken');

    const rawCookie = refreshCookieRaw(res);
    expect(rawCookie).toBeDefined();
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('Path=/auth');
    expect(rawCookie).toContain('SameSite=Strict');
    // secure se activa sólo en producción; en test el navegador es http local.
    expect(rawCookie).not.toContain('Secure');

    // maxAge 30 días (Express lo emite en segundos)
    const maxAge = Number(/Max-Age=(\d+)/.exec(rawCookie ?? '')?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 - 2);
  });

  it('el access token sólo lleva sub, iat, exp y jti', async () => {
    await api().post('/auth/register').send(CREDENTIALS);
    const res = await login(CREDENTIALS.email, CREDENTIALS.password);

    const payload = decodePayload(res.body.accessToken);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sub']);
    expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/);

    const lifetimeSeconds = Number(payload.exp) - Number(payload.iat);
    expect(lifetimeSeconds).toBe(15 * 60);
  });

  it('password incorrecta y email inexistente devuelven el MISMO cuerpo y status', async () => {
    await api().post('/auth/register').send(CREDENTIALS);

    const wrongPassword = await login(CREDENTIALS.email, 'contrasena-equivocada-123');
    const unknownEmail = await login('nadie@example.com', 'contrasena-equivocada-123');

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' },
    });
  });

  it('ignora un refresh token entrante y no revoca la sesión previa', async () => {
    const register = await api().post('/auth/register').send(CREDENTIALS);
    expect(register.status).toBe(201);

    const firstLogin = await api()
      .post('/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    const previousCookie = refreshCookieRaw(firstLogin)?.split(';')[0] ?? '';
    expect(previousCookie).not.toBe('');

    // Segundo login mandando la cookie del primero: debe abrir familia nueva.
    const secondLogin = await api()
      .post('/auth/login')
      .set('Cookie', previousCookie)
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    expect(secondLogin.status).toBe(200);
    expect(refreshCookieRaw(secondLogin)?.split(';')[0]).not.toBe(previousCookie);

    // La sesión anterior sigue viva.
    const refreshWithPrevious = await api()
      .post('/auth/refresh')
      .set('Cookie', previousCookie);
    expect(refreshWithPrevious.status).toBe(200);
  });
});
