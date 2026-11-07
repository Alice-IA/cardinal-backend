import type { TicketDeps } from '../../src/modules/tickets/ticket.service';
import { FakeRedis } from './fake-redis';

/**
 * Deps mínimas para construir el control plane en tests que no canjean
 * tickets (openapi, contract-http). El wiring real —ioredis + WS_TICKET_SECRET—
 * se conecta en la sesión del control plane.
 */
export const TEST_TICKET_SECRET = 'ticket-secret-de-test-32-caracteres!!';

export function makeTicketDeps(now: () => number = () => Date.now()): TicketDeps {
  return {
    store: new FakeRedis(now),
    secret: TEST_TICKET_SECRET,
    now,
    ttlSeconds: 30,
  };
}
