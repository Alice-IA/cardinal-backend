import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ticketAlreadyUsed,
  ticketExpired,
  ticketInvalid,
} from '../../utils/errors';

/**
 * Tickets efímeros para el handshake WS.
 *
 * Formato: base64url(payload) + '.' + base64url(hmac-sha256(payloadB64)).
 * El payload no lleva containerPort, internalHost ni nodeId.
 *
 * Nota de contrato: `tests/ticket.test.ts` hace
 * `const { ticket } = await issueTicket(...)`, así que el retorno real es
 * `{ ticket, expiresAt }`. El prompt de fase 1a decía `Promise<string>`;
 * cambiarlo a string exigiría cambiar el test y el contrato del control plane,
 * que necesita `expiresAt`.
 *
 * La emisión es sin estado: el jti lo genera el servidor con randomUUID() y no
 * se escribe en Redis. El test de colisión se eliminó porque el cliente no
 * puede inyectar jti.
 */

export interface TicketStoreSetOptions {
  EX: number;
  NX?: boolean;
}

/**
 * Subconjunto mínimo de Redis que el servicio necesita. En producción se
 * adapta `ioredis`; en los tests se usa un fake en memoria (ver
 * `tests/helpers/fake-redis.ts`).
 */
export interface TicketStore {
  set(key: string, value: string, options: TicketStoreSetOptions): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export interface IssueTicketInput {
  userId: string;
  agentId: string;
  containerId: string;
}

export interface TicketDeps {
  store: TicketStore;
  secret: string;
  /** Reloj inyectable para poder fabricar un ticket expirado sin sleep. */
  now?: () => number;
  ttlSeconds?: number;
}

export interface TicketPayload {
  userId: string;
  agentId: string;
  containerId: string;
  exp: number;
  jti: string;
}

export interface IssuedTicket {
  ticket: string;
  expiresAt: string;
}

export interface ConsumedTicket {
  userId: string;
  agentId: string;
  containerId: string;
}

const DEFAULT_TTL_SECONDS = 30;
const USED_KEY_PREFIX = 'ticket:used:';
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function currentSeconds(deps: TicketDeps): number {
  return Math.floor((deps.now?.() ?? Date.now()) / 1000);
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function encodePayload(payload: TicketPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function decodePayload(payloadB64: string): TicketPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw ticketInvalid();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw ticketInvalid();
  }

  const candidate = parsed as Partial<TicketPayload>;
  if (
    !isNonEmptyString(candidate.userId) ||
    !isNonEmptyString(candidate.agentId) ||
    !isNonEmptyString(candidate.containerId) ||
    !isNonEmptyString(candidate.jti) ||
    typeof candidate.exp !== 'number' ||
    !Number.isInteger(candidate.exp)
  ) {
    throw ticketInvalid();
  }

  return {
    userId: candidate.userId,
    agentId: candidate.agentId,
    containerId: candidate.containerId,
    exp: candidate.exp,
    jti: candidate.jti,
  };
}

export async function issueTicket(
  input: IssueTicketInput,
  deps: TicketDeps,
): Promise<IssuedTicket> {
  const ttlSeconds = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const jti = randomUUID();

  // La emisión es sin estado: no escribe en Redis ni depende de que Redis esté
  // arriba. El jti lo genera el servidor y el consumo es quien lo reserva.
  const payload: TicketPayload = {
    userId: input.userId,
    agentId: input.agentId,
    containerId: input.containerId,
    exp: currentSeconds(deps) + ttlSeconds,
    jti,
  };

  const payloadB64 = encodePayload(payload);
  const ticket = `${payloadB64}.${sign(payloadB64, deps.secret)}`;

  return {
    ticket,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export async function consumeTicket(
  ticket: string,
  deps: TicketDeps,
): Promise<ConsumedTicket> {
  const parts = ticket.split('.');
  if (parts.length !== 2) throw ticketInvalid();

  const [payloadB64, signatureB64] = parts as [string, string];
  if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(signatureB64)) {
    throw ticketInvalid();
  }

  const payload = decodePayload(payloadB64);

  const expectedSignature = Buffer.from(sign(payloadB64, deps.secret), 'base64url');
  const receivedSignature = Buffer.from(signatureB64, 'base64url');
  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    throw ticketInvalid();
  }

  if (payload.exp <= currentSeconds(deps)) throw ticketExpired();

  const ttlSeconds = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const marked = await deps.store.set(`${USED_KEY_PREFIX}${payload.jti}`, '1', {
    EX: ttlSeconds,
    NX: true,
  });
  if (marked === null) throw ticketAlreadyUsed();

  return {
    userId: payload.userId,
    agentId: payload.agentId,
    containerId: payload.containerId,
  };
}
