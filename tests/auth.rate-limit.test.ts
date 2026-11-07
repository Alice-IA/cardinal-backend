import { beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, api } from './helpers/client';
import { resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

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
