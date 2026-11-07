import argon2 from 'argon2';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { resetDb } from './helpers/db';
import {
  CREDENTIALS,
  agent,
  api,
  refreshCookieHeader,
  refreshCookieRaw,
  registerAndLogin,
} from './helpers/client';

/**
 * Copia de los 6 tests de auth existentes, ejecutados contra la app Express
 * real (la misma que usan `tests/auth.*.test.ts`) con supertest.
 *
 * Fase 0a: NO se usa `app.inject()` todavía. El control-plane Fastify es un
 * stub 501 sin rutas `/auth/*`; montarlo aquí solo verificaría el stub. La
 * migración a Fastify (fase 1) hará el cambio a `inject()` y entonces este
 * archivo debe seguir verde sin tocar sus asserts.
 *
 * Regla: los asserts originales no se tocan. Las dos precondiciones añadidas
 * están documentadas en `tests/README.md`.
 */

beforeEach(async () => {
  await resetDb();
});

// ─────────────────────────────────────────────────────────────
// auth.register.test.ts
// ─────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('crea el usuario y devuelve sólo la forma pública', async () => {
    const res = await api()
      .post('/auth/register')
      .send({ email: '  Ada@Example.COM ', password: CREDENTIALS.password, name: ' Ada ' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(res.body.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.user).not.toHaveProperty('password');

    const stored = await prisma.user.findFirst({ where: { email: 'ada@example.com' } });
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.passwordHash).toContain('m=19456,p=1,t=2');
    expect(await argon2.verify(stored!.passwordHash, CREDENTIALS.password)).toBe(true);
  });

  it('responde 409 con mensaje genérico si el email ya existe (case-insensitive)', async () => {
    const first = await api().post('/auth/register').send(CREDENTIALS);
    expect(first.status).toBe(201);

    const second = await api()
      .post('/auth/register')
      .send({ email: 'ADA@example.com', password: 'otra-contrasena-larga-456' });

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: { code: 'EMAIL_TAKEN', message: 'No se pudo completar el registro' },
    });
  });

  it('responde 400 si la contraseña tiene menos de 12 caracteres', async () => {
    const res = await api()
      .post('/auth/register')
      .send({ email: 'corta@example.com', password: 'corta123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([
      { field: 'password', issue: 'La contraseña debe tener al menos 12 caracteres' },
    ]);

    const count = await prisma.user.count();
    expect(count).toBe(0);
  });

  it('responde 400 si el email es inválido', async () => {
    const res = await api()
      .post('/auth/register')
      .send({ email: 'no-es-un-email', password: CREDENTIALS.password });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('email');
  });
});

describe('registro: tiempo de respuesta', () => {
  it('un email duplicado no responde significativamente más rápido que uno nuevo', async () => {
    const password = 'contrasena-de-medicion-123';
    const measure = async (promise: PromiseLike<unknown>): Promise<number> => {
      const startedAt = performance.now();
      await promise;
      return performance.now() - startedAt;
    };

    // Calentamiento: el primer argon2 de la corrida paga inicialización.
    // Precondición añadida en fase 0a: contra el stub 501 este test podía pasar
    // en falso porque todas las respuestas tardan lo mismo. El assert original
    // de tiempos no se toca.
    const warmup = await api().post('/auth/register').send({
      email: 'warmup@example.com',
      password,
    });
    expect(
      warmup.status,
      'la app Fastify debe implementar /auth/register (fase 0a: stub 501)',
    ).toBe(201);
    await api().post('/auth/register').send({ email: 'warmup@example.com', password });

    const successful: number[] = [];
    const duplicated: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      const email = `medicion-${i}@example.com`;
      successful.push(await measure(api().post('/auth/register').send({ email, password })));
      duplicated.push(await measure(api().post('/auth/register').send({ email, password })));
    }

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };

    const successMedian = median(successful);
    const duplicateMedian = median(duplicated);

    // 3x de tolerancia + suelo de 150 ms: el objetivo es detectar caminos que
    // se saltan el argon2 (≈0 ms), no medir microbenchmarks.
    expect(duplicateMedian).toBeLessThan(Math.max(successMedian * 3, 150));
  });
});

// ─────────────────────────────────────────────────────────────
// auth.login.test.ts
// ─────────────────────────────────────────────────────────────

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

    expect(res.status, 'la app Fastify debe emitir el accessToken (fase 0a: stub 501)').toBe(200);
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

// ─────────────────────────────────────────────────────────────
// auth.refresh.test.ts
// ─────────────────────────────────────────────────────────────

const refresh = (cookie: string) => api().post('/auth/refresh').set('Cookie', cookie);

describe('POST /auth/refresh', () => {
  it('rota el token: el anterior deja de funcionar y el nuevo sí', async () => {
    const { refreshCookie: first } = await registerAndLogin();

    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    expect(typeof rotated.body.accessToken).toBe('string');

    const second = refreshCookieHeader(rotated);
    expect(second).not.toBe(first);

    const withOld = await refresh(first);
    expect(withOld.status).toBe(401);
    expect(withOld.body.error.code).toBe('TOKEN_INVALID');

    const withNew = await refresh(second);
    expect(withNew.status).toBe(200);
  });

  it('un token reusado revoca toda la familia (el token hermano también cae)', async () => {
    const { refreshCookie: t1 } = await registerAndLogin();
    const t2 = refreshCookieHeader(await refresh(t1));
    const t3 = refreshCookieHeader(await refresh(t2));

    // Reuso real: t1 ya se usó y su sucesor (t2) también.
    const reuse = await refresh(t1);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('TOKEN_INVALID');

    // El "segundo dispositivo" con el token vigente queda fuera.
    const sibling = await refresh(t3);
    expect(sibling.status).toBe(401);
  });

  it('el reuso real marca revoked_at en todos los tokens de la familia', async () => {
    const { refreshCookie: t1 } = await registerAndLogin();
    const t2 = refreshCookieHeader(await refresh(t1));
    const t3 = refreshCookieHeader(await refresh(t2));

    expect((await refresh(t1)).status).toBe(401);

    const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
    for (const row of rows) {
      expect(row.revokedAt).not.toBeNull();
    }

    // y ningún token de la familia vuelve a servir
    expect((await refresh(t3)).status).toBe(401);
  });

  it('dos refresh concurrentes con el mismo token: sólo uno gana y la sesión que emite sigue viva', async () => {
    const { refreshCookie } = await registerAndLogin();

    const [first, second] = await Promise.all([refresh(refreshCookie), refresh(refreshCookie)]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    expect(loser.body.error.code).toBe('TOKEN_INVALID');

    // La corrida benigna no debe haber revocado la familia.
    const winnerCookie = refreshCookieHeader(winner);
    const third = await refresh(winnerCookie);
    expect(third.status).toBe(200);

    const rows = await prisma.refreshToken.findMany();
    expect(rows.some((row) => row.revokedAt !== null)).toBe(false);
  });

  it('responde 401 y borra la cookie si no hay cookie de refresh', async () => {
    const res = await api().post('/auth/refresh');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
    const cleared = refreshCookieRaw(res);
    expect(cleared).toBeDefined();
    expect(cleared).toContain('refresh_token=;');
  });

  it('responde 401 con un refresh token inventado', async () => {
    const res = await refresh('refresh_token=no-es-un-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});

// ─────────────────────────────────────────────────────────────
// auth.logout.test.ts
// ─────────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('revoca el refresh token y el refresh posterior falla', async () => {
    const client = agent();

    await client.post('/auth/register').send(CREDENTIALS);
    const loginRes = await client
      .post('/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    expect(loginRes.status).toBe(200);

    const logout = await client.post('/auth/logout');
    expect(logout.status).toBe(204);

    const rows = await prisma.refreshToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();

    // El cookie jar del agente ya recibió el borrado: no manda cookie.
    const afterLogout = await client.post('/auth/refresh');
    expect(afterLogout.status).toBe(401);
  });

  it('también falla el refresh si el cliente conserva la cookie revocada', async () => {
    const client = agent();
    await client.post('/auth/register').send(CREDENTIALS);
    const loginRes = await client
      .post('/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    const cookie = (loginRes.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(
      ';',
    )[0];
    expect(cookie).toBeDefined();

    await client.post('/auth/logout');

    // Reintento manual con la cookie vieja, como haría un cliente que la tenga
    // cacheada en memoria.
    const res = await api().post('/auth/refresh').set('Cookie', cookie!);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('es idempotente sin cookie: 204', async () => {
    const res = await api().post('/auth/logout');
    expect(res.status).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────
// auth.me.test.ts
// ─────────────────────────────────────────────────────────────

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
    const forged = await signWithSecret('un_secreto_distinto_de_al_menos_32_chars', {
      sub: userId,
      expSecondsFromNow: 900,
    });

    const res = await api().get('/auth/me').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});

// ─────────────────────────────────────────────────────────────
// auth.rate-limit.test.ts
// ─────────────────────────────────────────────────────────────

const attempt = (password: string) =>
  api().post('/auth/login').send({ email: CREDENTIALS.email, password });

describe('rate limit de login', () => {
  it('el sexto login fallido devuelve 429', async () => {
    await api().post('/auth/register').send(CREDENTIALS);

    for (let i = 0; i < 5; i += 1) {
      const res = await attempt('contrasena-equivocada-123');
      expect(res.status).toBe(401);
    }

    const blocked = await attempt('contrasena-equivocada-123');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Demasiados intentos. Intenta de nuevo más tarde.',
      },
    });
    expect(blocked.headers['retry-after']).toBe('900');
  });

  it('un login exitoso resetea el contador de la combinación ip+email', async () => {
    await api().post('/auth/register').send(CREDENTIALS);

    for (let i = 0; i < 4; i += 1) {
      expect((await attempt('contrasena-equivocada-123')).status).toBe(401);
    }

    const success = await attempt(CREDENTIALS.password);
    expect(success.status).toBe(200);

    // Si el contador no se hubiera reseteado, este sería el 6º fallo.
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt('contrasena-equivocada-123')).status).toBe(401);
    }
    expect((await attempt('contrasena-equivocada-123')).status).toBe(429);
  });
});

it.todo('[fase 1] los 24 auth contra Fastify con inject() sin tocar asserts');
