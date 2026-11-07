/**
 * Tickets efímeros para el handshake WS.
 *
 * FASE 0a: solo contrato. La implementación es la fase siguiente. Los tests
 * `tests/ticket.test.ts` fijan:
 * - formato base64url(payload).base64url(hmac)
 * - TTL de 30 s
 * - payload sin containerPort/internalHost
 * - jti de un solo uso (Redis)
 * - consumeTicket devuelve solo { userId, agentId, containerId }
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
  /** Solo para el test de colisión; en producción se genera aleatoriamente. */
  jti?: string;
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
  jti: string;
  iat: number;
  exp: number;
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

export async function issueTicket(
  _input: IssueTicketInput,
  _deps: TicketDeps,
): Promise<IssuedTicket> {
  throw new Error('not implemented: issueTicket');
}

export async function consumeTicket(
  _ticket: string,
  _deps: TicketDeps,
): Promise<ConsumedTicket> {
  throw new Error('not implemented: consumeTicket');
}
