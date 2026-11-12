import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildControlPlaneApp } from '../src/control-plane/app';
import { createRedisTicketStore } from '../src/modules/tickets/store.redis';
import { issueTicket, type TicketDeps } from '../src/modules/tickets/ticket.service';
import { createManagerClient, type SandboxManagerClient } from '../src/modules/provision/manager-client';
import type { ProvisionDeps } from '../src/modules/provision/provision.service';
import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';
import { encryptToken } from '../src/utils/crypto';
import { resetDb } from './helpers/db';
import { seedTenantFixture, type TenantFixture } from './helpers/fixtures';
import { FakeRedis } from './helpers/fake-redis';

/**
 * Contrato HTTP de la API interna que consumirá cardinal-gateway.
 *
 * El gateway no importa código del backend: canjea el ticket del handshake y
 * resuelve userId+agentId → host:port por HTTP, autenticándose con
 * `X-Internal-Token`. Estos tests fijan request, response y códigos de error.
 *
 * Decisión de diseño (route): un agente no resoluble responde **200** con
 * `{ error: 'NOT_FOUND' }`, NO 404. Un 404 obligaría al gateway a distinguir
 * "el backend no tiene esa ruta" de "el agente no existe / es de otro
 * usuario"; con 200 el cuerpo dice siempre qué pasó.
 *
 * El ticket nunca se loguea (ni completo ni truncado) y el token interno no
 * debe aparecer ni en la respuesta ni en el access log.
 */

const NOW = 1_700_000_000_000;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;
const TICKET_SECRET = 'ticket-secret-de-test-para-internal-api-32!!';

/** Mismo largo que el token real para ejercitar la comparación timing-safe. */
const WRONG_TOKEN = `${INTERNAL_TOKEN.slice(0, -1)}${INTERNAL_TOKEN.endsWith('a') ? 'b' : 'a'}`;

const CONSUME_URL = '/internal/tickets/consume';
const ROUTE_URL = '/internal/route';
const CREDENTIALS_URL = '/internal/credentials';

const ENCRYPTION_KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
const CAPABILITY_TOKEN = 'capability-token-de-alice-para-el-gateway';

let fixture: TenantFixture;
let store: FakeRedis;
let ticketDeps: TicketDeps;
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  fixture = await seedTenantFixture({ includeAliceSubAgent: false });

  store = new FakeRedis(() => NOW);
  ticketDeps = { store, secret: TICKET_SECRET, now: () => NOW, ttlSeconds: 30 };

  app = buildControlPlaneApp({ ticketDeps });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/** Petición interna con el header correcto salvo que se indique otro/nulo. */
function post(
  url: string,
  payload?: InjectOptions['payload'],
  token: string | null = INTERNAL_TOKEN,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method: 'POST',
    url,
    headers: token === null ? {} : { 'x-internal-token': token },
  };
  if (payload !== undefined) options.payload = payload;
  return app.inject(options);
}

async function issueValidTicket(overrides: Partial<TicketDeps> = {}): Promise<string> {
  const { ticket } = await issueTicket(
    {
      userId: fixture.alice.id,
      agentId: fixture.alice.primaryAgentId,
      containerId: fixture.alice.containerId,
    },
    { ...ticketDeps, ...overrides },
  );
  return ticket;
}

describe('internal API: POST /internal/tickets/consume', () => {
  it('sin header X-Internal-Token responde 401 INTERNAL_UNAUTHORIZED', async () => {
    const response = await post(CONSUME_URL, { ticket: await issueValidTicket() }, null);

    expect(response.statusCode, 'sin token interno no se puede canjear un ticket').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_UNAUTHORIZED' } });
  });

  it('con token incorrecto responde 401 INTERNAL_UNAUTHORIZED', async () => {
    const response = await post(
      CONSUME_URL,
      { ticket: await issueValidTicket() },
      WRONG_TOKEN,
    );

    expect(response.statusCode, 'un token interno incorrecto debe rechazarse').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_UNAUTHORIZED' } });
  });

  it('con token correcto y ticket válido responde 200 {userId, agentId, containerId}', async () => {
    const ticket = await issueValidTicket();

    const response = await post(CONSUME_URL, { ticket });

    expect(response.statusCode, 'el ticket válido debe canjearse').toBe(200);
    expect(response.json(), 'la respuesta no debe traer datos de enrutamiento').toEqual({
      userId: fixture.alice.id,
      agentId: fixture.alice.primaryAgentId,
      containerId: fixture.alice.containerId,
    });
  });

  it('el segundo consumo del mismo ticket responde 409 TICKET_ALREADY_USED', async () => {
    const ticket = await issueValidTicket();

    const first = await post(CONSUME_URL, { ticket });
    expect(first.statusCode, 'el primer consumo debe funcionar').toBe(200);

    const second = await post(CONSUME_URL, { ticket });
    expect(second.statusCode, 'reutilizar el ticket debe dar 409').toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'TICKET_ALREADY_USED' } });
  });

  it('un ticket con la firma alterada responde 401 TICKET_INVALID', async () => {
    const ticket = await issueValidTicket();
    const [payloadB64, signatureB64] = ticket.split('.') as [string, string];
    const tampered = `${payloadB64}.${signatureB64.startsWith('A') ? 'B' : 'A'}${signatureB64.slice(1)}`;

    const response = await post(CONSUME_URL, { ticket: tampered });

    expect(response.statusCode, 'una firma alterada debe rechazarse').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'TICKET_INVALID' } });
  });

  it('un ticket expirado responde 401 TICKET_EXPIRED (reloj desplazado)', async () => {
    // Se emite 60 s antes de NOW con TTL de 30 s: exp ya pasó al consumir.
    const ticket = await issueValidTicket({ now: () => NOW - 60_000 });

    const response = await post(CONSUME_URL, { ticket });

    expect(response.statusCode, 'un ticket con exp pasado debe rechazarse').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'TICKET_EXPIRED' } });
  });

  it('un body sin ticket (o con ticket no string) responde 400 VALIDATION_ERROR', async () => {
    const missing = await post(CONSUME_URL, {});
    expect(missing.statusCode, 'el body debe traer ticket').toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const notString = await post(CONSUME_URL, { ticket: 42 });
    expect(notString.statusCode, 'ticket debe ser string').toBe(400);
    expect(notString.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('la respuesta de éxito no contiene host, port ni nodeId', async () => {
    const response = await post(CONSUME_URL, { ticket: await issueValidTicket() });
    expect(response.statusCode, 'el canje debe responder 200').toBe(200);

    const body = response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('host');
    expect(body).not.toHaveProperty('port');
    expect(body).not.toHaveProperty('nodeId');
    expect(body).not.toHaveProperty('internalHost');
  });
});

describe('internal API: POST /internal/route', () => {
  it('alice resuelve su agente a {host, port, nodeId}', async () => {
    const response = await post(ROUTE_URL, {
      userId: fixture.alice.id,
      agentId: fixture.alice.primaryAgentId,
    });

    expect(response.statusCode, 'un agente propio debe resolverse').toBe(200);
    expect(response.json()).toEqual({
      host: '127.0.0.1',
      port: 9,
      nodeId: fixture.alice.nodeId,
    });
  });

  // 200 + NOT_FOUND, no 404: el gateway solo debe distinguir por el cuerpo.
  it('bob pidiendo el agente de alice responde 200 {error:NOT_FOUND}', async () => {
    const response = await post(ROUTE_URL, {
      userId: fixture.bob.id,
      agentId: fixture.alice.primaryAgentId,
    });

    expect(
      response.statusCode,
      'un agente ajeno es una petición válida con resultado vacío, no una ruta inexistente',
    ).toBe(200);
    expect(response.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('un contenedor en creating responde 200 {error:SANDBOX_NOT_READY}', async () => {
    await prisma.container.update({
      where: { id: fixture.alice.containerId },
      data: { status: 'creating' },
    });

    const response = await post(ROUTE_URL, {
      userId: fixture.alice.id,
      agentId: fixture.alice.primaryAgentId,
    });

    expect(response.statusCode, 'el motivo va en el cuerpo, no en el status').toBe(200);
    expect(response.json()).toEqual({ error: 'SANDBOX_NOT_READY' });
  });

  it('un nodo down responde 200 {error:NODE_UNAVAILABLE}', async () => {
    await prisma.node.update({
      where: { id: fixture.alice.nodeId },
      data: { status: 'down' },
    });

    const response = await post(ROUTE_URL, {
      userId: fixture.alice.id,
      agentId: fixture.alice.primaryAgentId,
    });

    expect(response.statusCode, 'el motivo va en el cuerpo, no en el status').toBe(200);
    expect(response.json()).toEqual({ error: 'NODE_UNAVAILABLE' });
  });

  it('la respuesta de error no contiene host, port, nodeId ni internalHost', async () => {
    const response = await post(ROUTE_URL, {
      userId: fixture.bob.id,
      agentId: fixture.alice.primaryAgentId,
    });

    expect(response.statusCode, 'el caso no resoluble debe responder 200').toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body), 'el error solo debe traer el motivo').toEqual(['error']);
    expect(body).not.toHaveProperty('host');
    expect(body).not.toHaveProperty('port');
    expect(body).not.toHaveProperty('nodeId');
    expect(body).not.toHaveProperty('internalHost');
  });
});

describe('internal API: POST /internal/route sin agentId (primario)', () => {
  it('resuelve el agente primario de alice a {host, port, nodeId}', async () => {
    const response = await post(ROUTE_URL, { userId: fixture.alice.id });

    expect(response.statusCode, 'sin agentId debe resolver el primario').toBe(200);
    expect(response.json()).toEqual({
      host: '127.0.0.1',
      port: 9,
      nodeId: fixture.alice.nodeId,
    });
  });

  it('con un subagente en el contenedor devuelve la ruta del primario', async () => {
    await prisma.agent.create({
      data: {
        agentId: 'agent-alice-sub-internal',
        containerId: fixture.alice.containerId,
        userId: fixture.alice.id,
        agentName: 'Subagente',
        isPrimary: false,
      },
    });

    const response = await post(ROUTE_URL, { userId: fixture.alice.id });

    expect(response.statusCode, 'el subagente no debe cambiar la ruta').toBe(200);
    expect(response.json()).toEqual({
      host: '127.0.0.1',
      port: 9,
      nodeId: fixture.alice.nodeId,
    });
  });

  it('agentId vacío responde 400 VALIDATION_ERROR (no es centinela)', async () => {
    const response = await post(ROUTE_URL, {
      userId: fixture.alice.id,
      agentId: '',
    });

    expect(response.statusCode, 'la cadena vacía no es un agentId válido').toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('un contenedor en creating responde 200 {error:SANDBOX_NOT_READY}', async () => {
    await prisma.container.update({
      where: { id: fixture.alice.containerId },
      data: { status: 'creating' },
    });

    const response = await post(ROUTE_URL, { userId: fixture.alice.id });

    expect(response.statusCode, 'el motivo va en el cuerpo, no en el status').toBe(200);
    expect(response.json()).toEqual({ error: 'SANDBOX_NOT_READY' });
  });

  it('un nodo down responde 200 {error:NODE_UNAVAILABLE}', async () => {
    await prisma.node.update({
      where: { id: fixture.alice.nodeId },
      data: { status: 'down' },
    });

    const response = await post(ROUTE_URL, { userId: fixture.alice.id });

    expect(response.statusCode, 'el motivo va en el cuerpo, no en el status').toBe(200);
    expect(response.json()).toEqual({ error: 'NODE_UNAVAILABLE' });
  });

  it('un usuario sin contenedor responde 200 {error:NOT_FOUND}', async () => {
    const user = await prisma.user.create({
      data: { email: 'sin-contenedor@example.com', passwordHash: 'test-only' },
    });

    const response = await post(ROUTE_URL, { userId: user.id });

    expect(response.statusCode, 'sin fila la petición sigue siendo válida').toBe(200);
    expect(response.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('la respuesta de error sin agentId no contiene host, port ni nodeId', async () => {
    const user = await prisma.user.create({
      data: { email: 'sin-contenedor-error@example.com', passwordHash: 'test-only' },
    });

    const response = await post(ROUTE_URL, { userId: user.id });

    expect(response.statusCode, 'el caso no resoluble debe responder 200').toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body), 'el error solo debe traer el motivo').toEqual(['error']);
    expect(body).not.toHaveProperty('host');
    expect(body).not.toHaveProperty('port');
    expect(body).not.toHaveProperty('nodeId');
    expect(body).not.toHaveProperty('internalHost');
  });
});

describe('internal API: TicketStore Redis (adaptador sobre fake)', () => {
  async function rebuildWith(deps: TicketDeps): Promise<void> {
    await app.close();
    app = buildControlPlaneApp({ ticketDeps: deps });
    await app.ready();
  }

  function redisDeps(store: FakeRedis): TicketDeps {
    return {
      store: createRedisTicketStore(store),
      secret: TICKET_SECRET,
      now: () => NOW,
      ttlSeconds: 30,
    };
  }

  it('un ticket emitido con el store Redis se consume con el mismo store → 200', async () => {
    const deps = redisDeps(new FakeRedis(() => NOW));
    await rebuildWith(deps);

    const { ticket } = await issueTicket(
      {
        userId: fixture.alice.id,
        agentId: fixture.alice.primaryAgentId,
        containerId: fixture.alice.containerId,
      },
      deps,
    );

    const response = await post(CONSUME_URL, { ticket });

    expect(response.statusCode, 'el adaptador Redis debe canjear el ticket').toBe(200);
    expect(response.json()).toEqual({
      userId: fixture.alice.id,
      agentId: fixture.alice.primaryAgentId,
      containerId: fixture.alice.containerId,
    });
  });

  it('el segundo consumo con el mismo store Redis → 409 TICKET_ALREADY_USED', async () => {
    const deps = redisDeps(new FakeRedis(() => NOW));
    await rebuildWith(deps);

    const { ticket } = await issueTicket(
      {
        userId: fixture.alice.id,
        agentId: fixture.alice.primaryAgentId,
        containerId: fixture.alice.containerId,
      },
      deps,
    );

    expect((await post(CONSUME_URL, { ticket })).statusCode).toBe(200);

    const second = await post(CONSUME_URL, { ticket });
    expect(second.statusCode, 'el replay debe detectarse en Redis').toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'TICKET_ALREADY_USED' } });
  });

  it('dos stores sobre el MISMO fake de Redis comparten el estado', async () => {
    const redis = new FakeRedis(() => NOW);
    const depsA = redisDeps(redis);
    const depsB = redisDeps(redis);

    const { ticket } = await issueTicket(
      {
        userId: fixture.alice.id,
        agentId: fixture.alice.primaryAgentId,
        containerId: fixture.alice.containerId,
      },
      depsA,
    );

    // El store A emitió (issueTicket no escribe) y el store B consume. Que el
    // ticket valga demuestra que el adapter no guarda estado propio.
    await rebuildWith(depsB);

    const first = await post(CONSUME_URL, { ticket });
    expect(first.statusCode, 'el ticket debe canjearse con otro adapter del mismo Redis').toBe(200);

    // Y el replay con el mismo store B también se detecta: la reserva NX vive
    // en el fake compartido, no en memoria del proceso.
    const second = await post(CONSUME_URL, { ticket });
    expect(second.statusCode, 'la reserva NX debe estar en Redis y ser compartida').toBe(409);
  });
});

describe('internal API: POST /internal/credentials', () => {
  async function seedCiphertext(ciphertext: string): Promise<void> {
    await prisma.container.update({
      where: { id: fixture.alice.containerId },
      data: { tokenCiphertext: ciphertext },
    });
  }

  /** Reconstruye la app con un logger capturable (access log + errores). */
  async function rebuildWithCapturedLogs(logs: string[]): Promise<void> {
    await app.close();
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    });
    app = buildControlPlaneApp({
      ticketDeps,
      logger: pino({ level: 'debug' }, stream),
    });
    await app.ready();
  }

  it('sin X-Internal-Token responde 401 INTERNAL_UNAUTHORIZED', async () => {
    const response = await post(
      CREDENTIALS_URL,
      { sandboxId: fixture.alice.containerId },
      null,
    );

    expect(response.statusCode, 'las credenciales exigen el token interno').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_UNAUTHORIZED' } });
  });

  it('con token interno incorrecto responde 401 INTERNAL_UNAUTHORIZED', async () => {
    const response = await post(
      CREDENTIALS_URL,
      { sandboxId: fixture.alice.containerId },
      WRONG_TOKEN,
    );

    expect(response.statusCode, 'un token interno incorrecto debe rechazarse').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_UNAUTHORIZED' } });
  });

  it('un sandboxId inexistente responde 404 SANDBOX_NOT_FOUND', async () => {
    const response = await post(CREDENTIALS_URL, { sandboxId: 'container-no-existe' });

    expect(response.statusCode, 'un sandbox inexistente no es un error interno').toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SANDBOX_NOT_FOUND' } });
  });

  it('un contenedor con token_ciphertext NULL responde 404 SANDBOX_NOT_FOUND', async () => {
    // El fixture no siembra token: es el caso de un contenedor provisionado
    // antes de esta migración.
    const response = await post(CREDENTIALS_URL, {
      sandboxId: fixture.alice.containerId,
    });

    expect(response.statusCode, 'sin ciphertext no hay token que entregar').toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SANDBOX_NOT_FOUND' } });
  });

  it('un contenedor con ciphertext válido devuelve el token descifrado exacto', async () => {
    await seedCiphertext(encryptToken(CAPABILITY_TOKEN, ENCRYPTION_KEY));

    const response = await post(CREDENTIALS_URL, {
      sandboxId: fixture.alice.containerId,
    });

    expect(response.statusCode, 'el token debe descifrarse').toBe(200);
    expect(response.json()).toStrictEqual({ token: CAPABILITY_TOKEN });
  });

  it('sandboxId vacío responde 400 VALIDATION_ERROR', async () => {
    const response = await post(CREDENTIALS_URL, { sandboxId: '' });

    expect(response.statusCode, 'la cadena vacía no identifica un sandbox').toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('body sin sandboxId responde 400 VALIDATION_ERROR', async () => {
    const response = await post(CREDENTIALS_URL, {});

    expect(response.statusCode, 'sandboxId es obligatorio').toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('ciphertext corrupto responde 500 INTERNAL_ERROR sin filtrar datos', async () => {
    const valid = encryptToken(CAPABILITY_TOKEN, ENCRYPTION_KEY);
    const payload = Buffer.from(valid, 'base64url');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    const corrupt = payload.toString('base64url');
    await seedCiphertext(corrupt);

    const logs: string[] = [];
    await rebuildWithCapturedLogs(logs);

    const response = await post(CREDENTIALS_URL, {
      sandboxId: fixture.alice.containerId,
    });

    expect(response.statusCode, 'un fallo de descifrado es un 500').toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });

    const body = response.body;
    expect(body, 'la respuesta no debe filtrar el ciphertext').not.toContain(corrupt);
    expect(body, 'la respuesta no debe filtrar la clave').not.toContain(
      env.TOKEN_ENCRYPTION_KEY,
    );

    const joined = logs.join('\n');
    expect(joined, 'el log no debe filtrar el ciphertext').not.toContain(corrupt);
    expect(joined, 'el log no debe filtrar la clave').not.toContain(env.TOKEN_ENCRYPTION_KEY);
  });

  it('la respuesta 200 tiene exactamente la propiedad token', async () => {
    await seedCiphertext(encryptToken(CAPABILITY_TOKEN, ENCRYPTION_KEY));

    const response = await post(CREDENTIALS_URL, {
      sandboxId: fixture.alice.containerId,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toStrictEqual(['token']);
    expect(body).toStrictEqual({ token: CAPABILITY_TOKEN });
  });

  it('el capability token no aparece en los logs capturados', async () => {
    const token = 'capability-token-que-nunca-debe-loguearse';
    const ciphertext = encryptToken(token, ENCRYPTION_KEY);
    await seedCiphertext(ciphertext);

    const logs: string[] = [];
    await rebuildWithCapturedLogs(logs);

    const response = await post(CREDENTIALS_URL, {
      sandboxId: fixture.alice.containerId,
    });

    expect(response.statusCode, 'la petición válida debe funcionar').toBe(200);
    expect(response.json()).toStrictEqual({ token });

    const joined = logs.join('\n');
    expect(joined, 'el token nunca se loguea, ni completo ni truncado').not.toContain(token);
    expect(joined, 'el ciphertext tampoco se loguea').not.toContain(ciphertext);
  });
});

describe('internal API: seguridad', () => {
  it('el token interno no aparece en la respuesta ni en el access log', async () => {
    // Reconstruimos la app con un logger capturable para inspeccionar su salida.
    await app.close();
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    });
    app = buildControlPlaneApp({
      ticketDeps,
      logger: pino({ level: 'debug' }, stream),
    });
    await app.ready();

    const response = await post(CONSUME_URL, { ticket: await issueValidTicket() });

    expect(response.statusCode, 'la petición de control debe funcionar').toBe(200);
    expect(JSON.stringify(response.json()), 'el token no viaja en el body').not.toContain(
      INTERNAL_TOKEN,
    );
    expect(JSON.stringify(response.headers), 'el token no se refleja en headers').not.toContain(
      INTERNAL_TOKEN,
    );
    expect(logs.join('\n'), 'el token interno no debe aparecer en el access log').not.toContain(
      INTERNAL_TOKEN,
    );
  });
});

describe('internal API: provision', () => {
  function makeProvisionDeps(manager?: SandboxManagerClient): ProvisionDeps {
    const fallback: SandboxManagerClient = {
      provision: async () => ({ status: 202 }),
      get: async (jobId) => ({ jobId, status: 'unknown' }),
      listOrphans: async () => [],
    };

    return {
      prisma,
      manager: manager ?? fallback,
      agentFactory: { create: async () => ({ agentId: 'agent-provision-api' }) },
      encryptionKey: ENCRYPTION_KEY,
      logger: pino({ level: 'silent' }),
      systemPrompt: 'persona de prueba',
    };
  }

  async function rebuildWithProvision(manager?: SandboxManagerClient): Promise<void> {
    await app.close();
    app = buildControlPlaneApp({
      ticketDeps,
      provisionDeps: makeProvisionDeps(manager),
    });
    await app.ready();
  }

  it('POST /internal/provision/ready sin token responde 401 INTERNAL_UNAUTHORIZED', async () => {
    const response = await post(
      '/internal/provision/ready',
      { jobId: randomUUID(), ok: true },
      null,
    );

    expect(response.statusCode, 'el callback exige el token interno').toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_UNAUTHORIZED' } });
  });

  it('POST /internal/provision/ready con jobId inexistente responde 200 e ignora', async () => {
    await rebuildWithProvision();

    const response = await post('/internal/provision/ready', {
      jobId: randomUUID(),
      ok: true,
      internalHost: 'sandbox-x',
      port: 4500,
      transport: 'ws',
      containerId: 'cid',
    });

    expect(response.statusCode, 'un job desconocido es idempotente').toBe(200);
    expect(await prisma.container.count({ where: { status: 'provisioning' } })).toBe(0);
  });

  it('GET /internal/provision/:jobId proxea al manager con X-Internal-Token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ jobId: 'job-proxy', status: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const manager = createManagerClient({
      baseUrl: 'http://sandbox-manager:8090',
      internalToken: 'manager-internal-token',
      fetchImpl: fakeFetch,
    });
    await rebuildWithProvision(manager);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/provision/job-proxy',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId: 'job-proxy', status: 'ready' });
    expect(calls, 'debe llamar exactamente una vez al manager').toHaveLength(1);
    expect(calls[0]!.url).toBe('http://sandbox-manager:8090/provision/job-proxy');
    expect(new Headers(calls[0]!.init.headers).get('x-internal-token')).toBe(
      'manager-internal-token',
    );
  });
});
