import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import {
  api,
  refreshCookieHeader,
  refreshCookieRaw,
  registerAndLogin,
} from './helpers/client';
import { resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

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
