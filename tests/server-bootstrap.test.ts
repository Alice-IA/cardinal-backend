import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer, type BuiltHttpServer } from '../src/server';
import { makeTicketDeps } from './helpers/ticket-deps';

/**
 * Cobertura del arranque de producción: un único `http.Server` en `PORT` con
 * reparto determinista por path.
 *
 * - `/auth/me` lo atiende Express (401 TOKEN_INVALID).
 * - `/internal/credentials` lo atiende Fastify (401 INTERNAL_UNAUTHORIZED).
 * - `/nada` cae en el 404 de Express.
 *
 * Se usa `buildHttpServer` (el mismo que arranca producción) con FakeRedis y
 * un puerto efímero: no se abre Redis real ni se toca el puerto de producción.
 */

let built: BuiltHttpServer;
let baseUrl: string;

beforeAll(async () => {
  built = await buildHttpServer(makeTicketDeps());
  await new Promise<void>((resolve) => {
    built.server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = built.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // undici puede dejar conexiones keep-alive; cerrarlas evita que el test
  // espere al timeout de `server.close()`.
  built.server.closeAllConnections?.();
  await built.close();
});

describe('server de producción: Express + Fastify en el mismo PORT', () => {
  it('un Content-Type no soportado responde 415, no 500', async () => {
    const response = await fetch(`${baseUrl}/internal/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });

    expect(response.status, 'Fastify rechaza el media type con 415').toBe(415);
    const body = (await response.json()) as { error: { code: string } };
    expect(
      body.error.code.startsWith('UNSUPPORTED') || body.error.code === 'BAD_REQUEST',
      `código inesperado: ${body.error.code}`,
    ).toBe(true);
  });

  it('un JSON inválido responde 400 VALIDATION_ERROR, no 500', async () => {
    const response = await fetch(`${baseUrl}/internal/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status, 'el parser de Fastify marca el body como inválido').toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('enruta /auth a Express, /internal a Fastify y el resto al 404 de Express', async () => {
    const auth = await fetch(`${baseUrl}/auth/me`);
    expect(auth.status, 'GET /auth/me debe atenderlo Express con 401').toBe(401);
    expect(await auth.json(), 'el cuerpo debe ser el de Express').toMatchObject({
      error: { code: 'TOKEN_INVALID' },
    });

    const internal = await fetch(`${baseUrl}/internal/credentials`, {
      method: 'POST',
    });
    expect(
      internal.status,
      'POST /internal/credentials debe atenderlo Fastify con 401',
    ).toBe(401);
    expect(await internal.json(), 'el cuerpo debe ser el de Fastify').toMatchObject({
      error: { code: 'INTERNAL_UNAUTHORIZED' },
    });

    const nothing = await fetch(`${baseUrl}/nada`);
    expect(nothing.status, 'una ruta desconocida cae en Express y da 404').toBe(404);
  });
});
