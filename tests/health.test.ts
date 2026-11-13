import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer, type BuiltHttpServer } from '../src/server';
import { makeTicketDeps } from './helpers/ticket-deps';

/**
 * Contrato de `/healthz` y `/readyz`.
 *
 * Se usa `buildHttpServer` (el mismo que arranca producción) con sondas
 * inyectadas: así se prueba el comportamiento real del handler (timeout,
 * 200/503, forma del JSON) sin necesitar Postgres ni Redis. `makeTicketDeps`
 * trae FakeRedis, igual que el resto de tests.
 */

const state = { db: true, redis: true };

/** Error de Redis que incluye la URL con credenciales: no debe salir en la respuesta. */
const REDIS_ERROR_WITH_URL = 'connect ECONNREFUSED redis://alice:supersecreto@10.0.0.9:6379';

let built: BuiltHttpServer;
let baseUrl: string;

beforeAll(async () => {
  built = await buildHttpServer(makeTicketDeps(), undefined, undefined, {
    db: async () => {
      if (!state.db) throw Object.assign(new Error('db caída'), { code: 'P1001' });
      return 1;
    },
    redis: async () => {
      if (!state.redis) throw new Error(REDIS_ERROR_WITH_URL);
      return 'PONG';
    },
  });

  await new Promise<void>((resolve) => {
    built.server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = built.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  built.server.closeAllConnections?.();
  await built.close();
});

describe('health y readiness del backend', () => {
  it('/healthz responde 200 sin auth y sin depender de DB ni Redis', async () => {
    // Aunque las dos dependencias estén caídas, liveness debe seguir en 200:
    // Docker y Caddy lo llaman sin token para saber si el proceso vive.
    state.db = false;
    state.redis = false;

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status, '/healthz no debe mirar dependencias').toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('/readyz responde 200 cuando DB y Redis responden', async () => {
    state.db = true;
    state.redis = true;

    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status, 'con las dos sondas ok debe ser 200').toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      checks: { db: true, redis: true },
    });
  });

  it('/readyz responde 503 cuando Redis no responde', async () => {
    state.db = true;
    state.redis = false;

    const response = await fetch(`${baseUrl}/readyz`);
    const body = (await response.json()) as {
      ok: boolean;
      checks: { db: boolean; redis: boolean };
    };

    expect(response.status, 'si Redis falla la instancia no está lista').toBe(503);
    expect(body).toEqual({ ok: false, checks: { db: true, redis: false } });
    // El error de Redis no debe filtrarse: puede llevar la URL con credenciales.
    expect(JSON.stringify(body)).not.toContain('redis://');
    expect(JSON.stringify(body)).not.toContain('supersecreto');
  });
});
