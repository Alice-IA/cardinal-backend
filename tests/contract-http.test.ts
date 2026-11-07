import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildControlPlaneApp } from '../src/control-plane/app';
import { prisma } from '../src/config/prisma';
import { resetDb } from './helpers/db';
import { seedTenantFixture, type TenantFixture } from './helpers/fixtures';
import { makeTicketDeps } from './helpers/ticket-deps';
import { signAccessToken } from './helpers/tokens';

const app = buildControlPlaneApp({ ticketDeps: makeTicketDeps() });
let fixture: TenantFixture;
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  // El contrato de /api/agents habla de 1 agente por usuario: sin subagente.
  fixture = await seedTenantFixture({ includeAliceSubAgent: false });
  aliceToken = await signAccessToken(fixture.alice.id);
  bobToken = await signAccessToken(fixture.bob.id);
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const INTERNAL_KEYS = ['internalHost', 'containerPort', 'wsSecretPath', 'nodeId'] as const;

/**
 * El contrato prohíbe estas claves en CUALQUIER profundidad de la respuesta
 * pública (p. ej. `node.nodeId`), no solo en el top-level.
 */
function findInternalKeys(value: unknown, path = 'body'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findInternalKeys(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if ((INTERNAL_KEYS as readonly string[]).includes(key)) found.push(`${path}.${key}`);
    found.push(...findInternalKeys(child, `${path}.${key}`));
  }
  return found;
}

describe('control plane: agentes', () => {
  it('GET /api/agents sin token responde 401 TOKEN_INVALID', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents' });

    expect(response.statusCode, 'sin token el control plane debe responder 401').toBe(401);
    expect(response.json(), 'el error debe ser TOKEN_INVALID').toMatchObject({
      error: { code: 'TOKEN_INVALID' },
    });
  });

  it('GET /api/agents con token de alice devuelve solo sus agentes (1)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents',
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'alice debe poder listar sus agentes').toBe(200);
    const body = response.json() as Array<{ agentId: string }>;
    expect(Array.isArray(body), 'GET /api/agents debe devolver un array plano de agentes').toBe(true);
    expect(body, 'alice debe ver exactamente 1 agente').toHaveLength(1);
    expect(body[0]?.agentId, 'el agente debe ser el de alice').toBe(
      fixture.alice.primaryAgentId,
    );
    expect(
      body.map((agent) => agent.agentId),
      'la lista no debe contener agentes de bob',
    ).not.toContain(fixture.bob.primaryAgentId);
  });

  it('GET /api/agents/<agente de bob> con token de alice responde 404, no 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.bob.primaryAgentId}`,
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'un recurso ajeno no debe revelar existencia (404, no 403)').toBe(
      404,
    );
    expect(response.json(), 'el cuerpo debe ser NOT_FOUND').toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('POST /api/agents/<agente de bob>/ws-ticket con token de alice responde 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.bob.primaryAgentId}/ws-ticket`,
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'pedir ticket para un agente ajeno debe dar 404').toBe(404);
    expect(response.json(), 'el cuerpo debe ser NOT_FOUND').toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('POST /api/agents/<alice>/ws-ticket devuelve ticket y expiresAt sin datos internos', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.alice.primaryAgentId}/ws-ticket`,
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'emitir ticket propio debe responder 200').toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(typeof body.ticket, 'el body debe traer ticket').toBe('string');
    expect(typeof body.expiresAt, 'el body debe traer expiresAt').toBe('string');
    expect(
      Number.isNaN(Date.parse(String(body.expiresAt))),
      'expiresAt debe ser una fecha ISO válida',
    ).toBe(false);
    expect(String(body.expiresAt), 'expiresAt debe serializarse en ISO UTC').toMatch(/Z$/);

    for (const forbidden of ['host', 'port', 'containerId']) {
      expect(body, `el ticket no debe filtrar ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('el body del ticket no tiene más de 2 campos top-level', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.alice.primaryAgentId}/ws-ticket`,
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'la emisión del ticket debe responder 200').toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(
      Object.keys(body).sort(),
      'el ticket solo debe exponer ticket y expiresAt',
    ).toEqual(['expiresAt', 'ticket']);
  });
});

describe('control plane: sandbox', () => {
  it('GET /api/sandbox con contenedor creating responde 200 sin internalHost', async () => {
    await prisma.container.update({
      where: { id: fixture.alice.containerId },
      data: { status: 'creating' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/sandbox',
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'el estado del sandbox debe responder 200').toBe(200);
    const body = response.json() as Record<string, any>;
    expect(body.status, 'el status debe ser creating').toBe('creating');
    expect(body.node, 'la respuesta debe incluir el nodo').toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(body, 'lastSeenAt'), 'debe incluir lastSeenAt').toBe(
      true,
    );
    expect(findInternalKeys(body), 'la respuesta no debe exponer claves internas').toEqual([]);
  });

  it('GET /api/sandbox con nodo down expone node.status sin datos internos', async () => {
    await prisma.node.update({
      where: { id: fixture.alice.nodeId },
      data: { status: 'down' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/sandbox',
      headers: auth(aliceToken),
    });

    expect(response.statusCode, 'un nodo down no debe romper el endpoint de estado').toBe(200);
    const body = response.json() as Record<string, any>;
    expect(typeof body.status, 'el body debe incluir status').toBe('string');
    expect(body.node?.status, 'el body debe incluir node.status=down').toBe('down');
    expect(
      findInternalKeys(body),
      'el estado del sandbox no debe exponer claves internas ni en node.*',
    ).toEqual([]);
  });

  it('POST /api/sandbox/restart responde 202 sin bloquear más de 50 ms', async () => {
    const started = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/sandbox/restart',
      headers: auth(aliceToken),
    });
    const elapsed = performance.now() - started;

    expect(response.statusCode, 'restart debe aceptarse con 202').toBe(202);
    expect(elapsed, 'restart no debe esperar a que el contenedor esté listo').toBeLessThan(50);
  });
});

describe('control plane: creación de agentes', () => {
  it('POST /api/agents responde 404 o 405: el usuario no puede crear agentes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: auth(aliceToken),
      payload: { agent_name: 'Intruso' },
    });

    expect(
      [404, 405],
      'crear agentes debe estar prohibido con 404 o 405',
    ).toContain(response.statusCode);
  });
});
