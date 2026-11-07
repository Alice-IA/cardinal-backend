import { jwtVerify } from 'jose';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { GATEWAY_WS_PATH } from '../src/gateway/app';
import { resetDb } from './helpers/db';
import { seedTenantFixture, type TenantFixture } from './helpers/fixtures';
import { FakeAgentServer } from './helpers/fake-agent-server';
import {
  connectExpectHttpStatus,
  startGateway,
  WsClient,
  type RunningGateway,
} from './helpers/gateway';
import { createSecretFile, type SecretFile } from './helpers/secret-file';
import { signAccessToken } from './helpers/tokens';

let fake: FakeAgentServer;
let gateway: RunningGateway;
let fixture: TenantFixture;
let secretFile: SecretFile;
let aliceToken: string;
let bobToken: string;
const clients: WsClient[] = [];

const wsPath = (agentId: string): string =>
  GATEWAY_WS_PATH.replace(':agentId', agentId);

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
  for (const client of clients.splice(0)) client.terminate();
  await gateway?.app.close();
  await fake?.close();
});

async function connectAlice(): Promise<WsClient> {
  const client = await WsClient.connect(`${gateway.wsUrl}${wsPath(fixture.alice.primaryAgentId)}`, {
    authorization: `Bearer ${aliceToken}`,
  });
  clients.push(client);
  return client;
}

describe('gateway WS: autenticación y tenant', () => {
  it('sin Authorization responde 401 y no llega ningún upgrade al upstream', async () => {
    const rejected = await connectExpectHttpStatus(
      `${gateway.wsUrl}${wsPath(fixture.alice.primaryAgentId)}`,
    );

    expect(rejected.statusCode, 'sin Authorization el upgrade debe rechazarse con 401').toBe(401);
    expect(
      fake.upgradeRequests.length,
      'el upstream no debe recibir el upgrade cuando falta Authorization',
    ).toBe(0);
  });

  it('un token de bob no abre la conexión al contenedor de alice', async () => {
    const rejected = await connectExpectHttpStatus(
      `${gateway.wsUrl}${wsPath(fixture.alice.primaryAgentId)}`,
      { authorization: `Bearer ${bobToken}` },
    );

    expect(
      rejected.statusCode,
      'un agente ajeno debe responder NOT_FOUND (404), no FORBIDDEN',
    ).toBe(404);
    expect(rejected.body, 'el cuerpo debe llevar el código NOT_FOUND').toContain('NOT_FOUND');
    expect(
      fake.upgradeRequests.length,
      'el upstream de alice no debe recibir el upgrade de bob',
    ).toBe(0);
  });
});

describe('gateway WS: handshake con el upstream', () => {
  it('reenvía un JWT de contenedor con aud sandbox:<containerId> y exp <= 60 s', async () => {
    const upgradePromise = fake.nextUpgrade();
    const client = await connectAlice();
    const upgrade = await upgradePromise;

    const authorization = upgrade.headers.authorization;
    expect(
      authorization,
      'el upstream debe recibir Authorization con el token del contenedor',
    ).toMatch(/^Bearer /);

    const token = authorization!.slice('Bearer '.length);
    const payloadPart = token.split('.')[1];
    expect(payloadPart, 'el token debe ser un JWT').toBeDefined();
    const claims = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8')) as {
      aud?: string;
      exp?: number;
    };

    expect(claims.aud, 'el token del contenedor debe llevar aud sandbox:<containerId>').toBe(
      `sandbox:${fixture.alice.containerId}`,
    );
    expect(
      claims.exp! - Math.floor(Date.now() / 1000),
      'el token del contenedor no debe durar más de 60 s',
    ).toBeLessThanOrEqual(60);

    await jwtVerify(token, secretFile.secret, {
      audience: `sandbox:${fixture.alice.containerId}`,
    });
    client.close();
  });

  it('no reenvía el Origin del cliente al upstream', async () => {
    const upgradePromise = fake.nextUpgrade();
    const client = await connectAliceWithOrigin();
    const upgrade = await upgradePromise;

    expect(
      upgrade.headers.origin,
      'el gateway no debe reenviar Origin al app-server',
    ).toBeUndefined();
    client.close();
  });

  async function connectAliceWithOrigin(): Promise<WsClient> {
    const client = await WsClient.connect(
      `${gateway.wsUrl}${wsPath(fixture.alice.primaryAgentId)}`,
      {
        authorization: `Bearer ${aliceToken}`,
        origin: 'http://evil.example',
      },
    );
    clients.push(client);
    return client;
  }
});

describe('gateway WS: pipe bidireccional', () => {
  it('un mensaje de texto del cliente llega al upstream y el eco vuelve', async () => {
    const client = await connectAlice();
    client.send('hola upstream');

    expect(await client.nextText(), 'el eco de texto debe volver íntegro').toBe('hola upstream');
    client.close();
  });

  it('un Buffer de 64 KB va y vuelve íntegro', async () => {
    const client = await connectAlice();
    const payload = Buffer.alloc(64 * 1024, 0xab);
    client.send(payload);

    const received = await client.nextBinary();
    expect(
      Buffer.compare(received, payload),
      'el pipe binario debe preservar los 64 KB sin corrupción',
    ).toBe(0);
    client.close();
  });

  it('recibe los 5 stream_delta del upstream en orden', async () => {
    fake.mode = 'stream';
    const client = await connectAlice();

    const deltas: Array<{ type: string; index: number }> = [];
    for (let i = 0; i < 5; i += 1) {
      deltas.push(JSON.parse(await client.nextText()) as { type: string; index: number });
    }

    expect(deltas.map((delta) => delta.type), 'todos los frames deben ser stream_delta').toEqual(
      Array(5).fill('stream_delta'),
    );
    expect(deltas.map((delta) => delta.index), 'los deltas deben llegar en orden').toEqual([
      0, 1, 2, 3, 4,
    ]);
    client.close();
  });
});

describe('gateway WS: límites y errores', () => {
  it('rechaza el segundo WS del mismo usuario con 4409 y deja vivo el primero', async () => {
    const first = await connectAlice();
    const second = await WsClient.connect(
      `${gateway.wsUrl}${wsPath(fixture.alice.primaryAgentId)}`,
      { authorization: `Bearer ${aliceToken}` },
    );
    clients.push(second);

    const close = await second.waitClose();
    expect(close.code, 'el segundo WS debe cerrarse con 4409 CONNECTION_LIMIT').toBe(4409);
    expect(first.ws.readyState, 'el primer WS debe seguir abierto').toBe(WebSocket.OPEN);
    first.close();
  });

  it('contenedor en creating cierra con 4503 y SANDBOX_NOT_READY', async () => {
    await prisma.container.update({
      where: { id: fixture.alice.containerId },
      data: { status: 'creating' },
    });

    const client = await connectAlice();
    const close = await client.waitClose();

    expect(close.code, 'un sandbox no listo debe cerrar con 4503').toBe(4503);
    const detail = `${close.reason}\n${client.receivedText.join('\n')}`;
    expect(detail, 'el close o un frame previo debe identificar SANDBOX_NOT_READY').toContain(
      'SANDBOX_NOT_READY',
    );
  });

  it('nodo down cierra con 4503 y NODE_UNAVAILABLE', async () => {
    await prisma.node.update({
      where: { id: fixture.alice.nodeId },
      data: { status: 'down' },
    });

    const client = await connectAlice();
    const close = await client.waitClose();

    expect(close.code, 'un nodo down debe cerrar con 4503').toBe(4503);
    const detail = `${close.reason}\n${client.receivedText.join('\n')}`;
    expect(detail, 'el close o un frame previo debe identificar NODE_UNAVAILABLE').toContain(
      'NODE_UNAVAILABLE',
    );
  });

  it('si el upstream rechaza el upgrade con 401, el cliente recibe close 4401', async () => {
    fake.mode = 'reject';
    const client = await connectAlice();
    const close = await client.waitClose();

    expect(close.code, 'un upstream que rechaza no debe colgar al cliente').toBe(4401);
  });

  it('al cerrar el gateway se cierran todos los sockets cliente y upstream', async () => {
    const connectionPromise = fake.nextConnection();
    const client = await connectAlice();
    const upstream = await connectionPromise;

    const clientClosed = client.waitClose();
    const upstreamClosed = new Promise<void>((resolve) => upstream.once('close', () => resolve()));

    await gateway.app.close();

    await clientClosed;
    await upstreamClosed;
    expect(client.ws.readyState, 'el socket cliente debe quedar cerrado').not.toBe(WebSocket.OPEN);
  });
});
