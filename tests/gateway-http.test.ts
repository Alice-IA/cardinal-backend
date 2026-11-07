import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { resetDb } from './helpers/db';
import { seedTenantFixture, type TenantFixture } from './helpers/fixtures';
import { FakeAgentServer } from './helpers/fake-agent-server';
import { startGateway, type RunningGateway } from './helpers/gateway';
import { createSecretFile, type SecretFile } from './helpers/secret-file';
import { signAccessToken } from './helpers/tokens';

let fake: FakeAgentServer;
let gateway: RunningGateway;
let fixture: TenantFixture;
let secretFile: SecretFile;
let aliceToken: string;
let bobToken: string;

beforeEach(async () => {
  await resetDb();
  fixture = await seedTenantFixture({ includeAliceSubAgent: true });
  fake = await FakeAgentServer.start('echo');
  secretFile = await createSecretFile();

  await prisma.node.update({
    where: { id: fixture.alice.nodeId },
    data: { host: '127.0.0.1', port: fake.portNumber },
  });
  await prisma.node.update({
    where: { id: fixture.bob.nodeId },
    data: { host: '127.0.0.1', port: fake.portNumber },
  });
  await prisma.container.update({
    where: { id: fixture.alice.containerId },
    data: { wsSecretPath: secretFile.path },
  });

  aliceToken = await signAccessToken(fixture.alice.id);
  bobToken = await signAccessToken(fixture.bob.id);
  gateway = await startGateway({ upstreamTimeoutMs: 100 });
});

afterEach(async () => {
  await gateway?.app.close();
  await fake?.close();
});

async function verifyUpstreamAuth(authorization: string | undefined): Promise<void> {
  expect(authorization, 'el upstream debe recibir Authorization').toMatch(/^Bearer /);
  const token = authorization!.slice('Bearer '.length);
  await jwtVerify(token, secretFile.secret, {
    audience: `sandbox:${fixture.alice.containerId}`,
  });
}

describe('gateway HTTP: proxy autenticado', () => {
  it('GET /v1/agents reenvía el JWT del contenedor y filtra a solo is_primary', async () => {
    const requestPromise = fake.nextRequest(1000).catch(() => undefined);
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode, 'GET /v1/agents debe responder 200').toBe(200);
    // El fake imita al app-server devolviendo { agents: [...] }. El gateway
    // desanida en este handler y devuelve un array plano, que es lo que
    // consume el SDK de letta-oss-ui.
    const body = response.json() as Array<{ is_primary: boolean }>;
    expect(Array.isArray(body), 'GET /v1/agents debe devolver un array plano').toBe(true);
    expect(body, 'el cliente solo debe recibir el agente primario').toHaveLength(1);
    expect(body[0]?.is_primary, 'el agente devuelto debe ser primario').toBe(true);

    const upstream = await requestPromise;
    expect(upstream, 'el upstream debe recibir la petición proxy').toBeDefined();
    await verifyUpstreamAuth(upstream?.headers.authorization);
  });

  it('aunque el upstream devuelva 5 agentes, al cliente le llega 1', async () => {
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    const body = response.json() as unknown[];
    expect(response.statusCode, 'la respuesta debe ser 200').toBe(200);
    expect(Array.isArray(body), 'el gateway debe devolver un array plano').toBe(true);
    expect(body, 'el filtro de is_primary debe quedarse con 1 de 5').toHaveLength(1);
    expect(fake.httpRequests.length, 'el gateway debe consultar el upstream').toBeGreaterThan(0);
  });

  it('GET /v1/agents/<agente de bob> con token de alice es 404 sin tocar el upstream', async () => {
    const before = fake.httpRequests.length;
    const response = await gateway.app.inject({
      method: 'GET',
      url: `/v1/agents/${fixture.bob.primaryAgentId}`,
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode, 'un agente ajeno debe dar 404 NOT_FOUND').toBe(404);
    expect(response.json(), 'el cuerpo debe llevar NOT_FOUND').toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(
      fake.httpRequests.length,
      'el gateway no debe consultar el upstream por un agente ajeno',
    ).toBe(before);
  });

  it('GET /app-server-info se reenvía y responde', async () => {
    const requestPromise = fake.nextRequest(1000).catch(() => undefined);
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/app-server-info',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode, 'GET /app-server-info debe responder 200').toBe(200);
    expect(response.json(), 'la respuesta del fake debe reenviarse').toMatchObject({ ok: true });

    const upstream = await requestPromise;
    expect(upstream, 'el upstream debe recibir /app-server-info').toBeDefined();
    expect(upstream?.url, 'el upstream debe recibir /app-server-info').toContain('/app-server-info');
  });

  it('DELETE /v1/agents/x responde 405 y no toca el upstream', async () => {
    const before = fake.httpRequests.length;
    const response = await gateway.app.inject({
      method: 'DELETE',
      url: '/v1/agents/x',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode, 'el gateway no permite DELETE').toBe(405);
    expect(fake.httpRequests.length, 'un DELETE no debe llegar al upstream').toBe(before);
  });

  it('un 500 del upstream se transforma en 502 UPSTREAM_ERROR', async () => {
    const requestPromise = fake.nextRequest(1000).catch(() => undefined);
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/agents?status=500',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode, 'el 500 crudo no debe propagarse').toBe(502);
    expect(response.json(), 'el cliente debe recibir UPSTREAM_ERROR').toMatchObject({
      error: { code: 'UPSTREAM_ERROR' },
    });
    expect(await requestPromise, 'el gateway debe llegar al upstream').toBeDefined();
  });

  it('un upstream más lento que UPSTREAM_TIMEOUT_MS devuelve 502', async () => {
    const requestPromise = fake.nextRequest(1000).catch(() => undefined);
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/agents?delay=2000',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode, 'el timeout del upstream debe mapear a 502').toBe(502);
    expect(response.json(), 'el timeout debe reportar UPSTREAM_ERROR').toMatchObject({
      error: { code: 'UPSTREAM_ERROR' },
    });
    expect(await requestPromise, 'el gateway debe llegar al upstream').toBeDefined();
  });

  it('reescribe Host al upstream y no reenvía el Origin del cliente', async () => {
    const requestPromise = fake.nextRequest(1000).catch(() => undefined);
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: {
        authorization: `Bearer ${aliceToken}`,
        host: 'cliente.example',
        origin: 'http://evil.example',
      },
    });

    expect(response.statusCode, 'la petición debe completarse').toBe(200);
    const upstream = await requestPromise;
    expect(upstream, 'el gateway debe llegar al upstream').toBeDefined();
    expect(upstream?.headers.host, 'Host debe reescribirse al del upstream').toBe(
      `127.0.0.1:${fake.portNumber}`,
    );
    expect(upstream?.headers.origin, 'Origin del cliente no debe reenviarse').toBeUndefined();
  });
});
