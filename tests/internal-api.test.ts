import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildControlPlaneApp } from '../src/control-plane/app';
import { issueTicket, type TicketDeps } from '../src/modules/tickets/ticket.service';
import { prisma } from '../src/config/prisma';
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
