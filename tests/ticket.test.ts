import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeTicket,
  issueTicket,
  type TicketDeps,
  type TicketPayload,
} from '../src/modules/tickets/ticket.service';
import { FakeRedis } from './helpers/fake-redis';

const SECRET = 'ticket-secret-de-test-de-32-caracteres!!';
const NOW = 1_700_000_000_000;
const INPUT = {
  userId: '11111111-1111-4111-8111-111111111111',
  agentId: 'agent-alice-primary',
  containerId: 'container-alice',
  jti: 'jti-fijo-para-el-test',
};

let store: FakeRedis;
let deps: TicketDeps;

beforeEach(() => {
  store = new FakeRedis(() => NOW);
  deps = {
    store,
    secret: SECRET,
    now: () => NOW,
    ttlSeconds: 30,
  };
});

function decode(ticket: string): { payloadB64: string; signatureB64: string; payload: TicketPayload } {
  const parts = ticket.split('.');
  expect(parts, 'el ticket debe tener exactamente dos segmentos base64url').toHaveLength(2);
  const [payloadB64, signatureB64] = parts as [string, string];
  return {
    payloadB64,
    signatureB64,
    payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TicketPayload,
  };
}

describe('issueTicket', () => {
  it('emite base64url(payload).base64url(hmac) con exp = now + 30', async () => {
    const { ticket } = await issueTicket(INPUT, deps);
    const { payloadB64, signatureB64, payload } = decode(ticket);

    expect(payload.exp - Math.floor(NOW / 1000), 'el ticket debe durar exactamente 30 s').toBe(30);
    expect(payload.userId, 'el payload debe llevar el usuario').toBe(INPUT.userId);
    expect(payload.agentId, 'el payload debe llevar el agente').toBe(INPUT.agentId);
    expect(payload.containerId, 'el payload debe llevar el contenedor').toBe(INPUT.containerId);
    expect(payload.jti, 'el payload debe llevar el jti').toBe(INPUT.jti);

    const expected = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    expect(signatureB64, 'la firma debe ser HMAC-SHA256 del payload').toBe(expected);
  });

  it('el payload no filtra containerPort ni internalHost al cliente', async () => {
    const { ticket } = await issueTicket(INPUT, deps);
    const { payload } = decode(ticket);

    expect(payload, 'el payload no debe contener containerPort').not.toHaveProperty(
      'containerPort',
    );
    expect(payload, 'el payload no debe contener internalHost').not.toHaveProperty(
      'internalHost',
    );
  });

  it('falla si el jti ya fue reservado (no reutiliza jti)', async () => {
    await issueTicket({ ...INPUT, jti: 'jti-repetido' }, deps);

    await expect(
      issueTicket({ ...INPUT, jti: 'jti-repetido' }, deps),
      'issueTicket debe rechazar un jti ya reservado',
    ).rejects.toThrow();
  });
});

describe('consumeTicket', () => {
  it('rechaza una firma alterada con TICKET_INVALID', async () => {
    const { ticket } = await issueTicket(INPUT, deps);
    const { payloadB64, signatureB64 } = decode(ticket);
    const tamperedSignature = `${signatureB64.startsWith('A') ? 'B' : 'A'}${signatureB64.slice(1)}`;
    const tampered = `${payloadB64}.${tamperedSignature}`;

    await expect(
      consumeTicket(tampered, deps),
      'una firma alterada debe dar TICKET_INVALID',
    ).rejects.toMatchObject({ code: 'TICKET_INVALID' });
  });

  it('rechaza un ticket expirado con TICKET_EXPIRED (reloj desplazado)', async () => {
    const { ticket } = await issueTicket(INPUT, {
      ...deps,
      now: () => NOW - 60_000,
    });

    await expect(
      consumeTicket(ticket, deps),
      'un ticket con exp pasado debe dar TICKET_EXPIRED',
    ).rejects.toMatchObject({ code: 'TICKET_EXPIRED' });
  });

  it('el segundo consumo del mismo jti da TICKET_ALREADY_USED y deja TTL en Redis', async () => {
    const { ticket } = await issueTicket(INPUT, deps);
    const { payload } = decode(ticket);

    const first = await consumeTicket(ticket, deps);
    expect(first, 'el primer consumo debe devolver el contexto del ticket').toMatchObject({
      userId: INPUT.userId,
      agentId: INPUT.agentId,
      containerId: INPUT.containerId,
    });

    const keys = await store.keys(`*${payload.jti}*`);
    expect(keys.length, 'consumeTicket debe crear al menos una clave de Redis para el jti').toBeGreaterThan(0);
    for (const key of keys) {
      const ttl = await store.ttl(key);
      expect(ttl, `la clave ${key} debe tener TTL entre 25 y 30 s`).toBeGreaterThanOrEqual(25);
      expect(ttl, `la clave ${key} debe tener TTL entre 25 y 30 s`).toBeLessThanOrEqual(30);
    }

    await expect(
      consumeTicket(ticket, deps),
      'el segundo consumo del mismo jti debe dar TICKET_ALREADY_USED',
    ).rejects.toMatchObject({ code: 'TICKET_ALREADY_USED' });
  });

  it('devuelve solo userId, agentId y containerId; sin host ni port', async () => {
    const { ticket } = await issueTicket(INPUT, deps);
    const consumed = await consumeTicket(ticket, deps);

    expect(
      Object.keys(consumed).sort(),
      'consumeTicket no debe devolver datos de enrutamiento; el gateway vuelve a resolver contra la DB',
    ).toEqual(['agentId', 'containerId', 'userId']);
    expect(consumed, 'consumeTicket no debe devolver host').not.toHaveProperty('host');
    expect(consumed, 'consumeTicket no debe devolver port').not.toHaveProperty('port');
  });
});
