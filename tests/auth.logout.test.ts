import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { CREDENTIALS, agent, api } from './helpers/client';
import { resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

describe('POST /auth/logout', () => {
  it('revoca el refresh token y el refresh posterior falla', async () => {
    const client = agent();

    await client.post('/auth/register').send(CREDENTIALS);
    const login = await client
      .post('/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    expect(login.status).toBe(200);

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
    const login = await client
      .post('/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    const cookie = (login.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0];
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
