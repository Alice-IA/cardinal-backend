import argon2 from 'argon2';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { CREDENTIALS, api } from './helpers/client';
import { resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

describe('POST /auth/register', () => {
  it('crea el usuario y devuelve sólo la forma pública', async () => {
    const res = await api()
      .post('/auth/register')
      .send({ email: '  Ada@Example.COM ', password: CREDENTIALS.password, name: ' Ada ' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(res.body.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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
    const measure = async (promise: Promise<unknown>): Promise<number> => {
      const startedAt = performance.now();
      await promise;
      return performance.now() - startedAt;
    };

    // Calentamiento: el primer argon2 de la corrida paga inicialización.
    await api().post('/auth/register').send({ email: 'warmup@example.com', password });
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
