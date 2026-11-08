import { describe, expect, it } from 'vitest';
import {
  createRedisTicketStore,
  type RedisLike,
} from '../src/modules/tickets/store.redis';
import { FakeRedis } from './helpers/fake-redis';

/**
 * Contrato del `TicketStore` real sobre Redis.
 *
 * No hay Redis en CI: el adaptador se ejercita contra `FakeRedis` (en memoria),
 * que implementa tanto `TicketStore` como `RedisLike`. Lo que estos tests fijan
 * es la traducción exacta de `set(key, value, {EX, NX})` a la forma de ioredis
 * `set(key, value, 'EX', seconds, 'NX')` y que `get`/`ttl`/`keys` se delegan
 * sin transformar los valores.
 */

const NOW = 1_700_000_000_000;

function makeStore(): { client: RedisLike; store: ReturnType<typeof createRedisTicketStore> } {
  const client: RedisLike = new FakeRedis(() => NOW);
  return { client, store: createRedisTicketStore(client) };
}

describe('createRedisTicketStore', () => {
  it('SET con NX crea la key una vez y la segunda devuelve null', async () => {
    const { store } = makeStore();

    const first = await store.set('ticket:used:jti-1', '1', { EX: 30, NX: true });
    expect(first, 'la primera reserva NX debe ser un éxito').toBe('OK');

    const second = await store.set('ticket:used:jti-1', '1', { EX: 30, NX: true });
    expect(second, 'la segunda reserva NX debe devolver null').toBeNull();
  });

  it('GET devuelve exactamente lo escrito', async () => {
    const { store } = makeStore();

    await store.set('ticket:value', 'contenido', { EX: 30 });
    expect(await store.get('ticket:value')).toBe('contenido');
  });

  it('GET de una key inexistente devuelve null', async () => {
    const { store } = makeStore();

    expect(await store.get('ticket:used:no-existe')).toBeNull();
  });

  it('TTL tras un SET EX 30 devuelve un valor entre 1 y 30', async () => {
    const { store } = makeStore();

    await store.set('ticket:used:ttl', '1', { EX: 30 });
    const ttl = await store.ttl('ticket:used:ttl');

    expect(ttl, 'un SET EX 30 debe dejar TTL positivo').toBeGreaterThanOrEqual(1);
    expect(ttl, 'un SET EX 30 no puede superar 30 s').toBeLessThanOrEqual(30);
  });

  it("KEYS('ticket:used:*') devuelve solo las keys que casan", async () => {
    const { store } = makeStore();

    await store.set('ticket:used:a', '1', { EX: 30 });
    await store.set('ticket:used:b', '1', { EX: 30 });
    await store.set('ticket:other:c', '1', { EX: 30 });

    const keys = await store.keys('ticket:used:*');

    expect(keys.sort()).toEqual(['ticket:used:a', 'ticket:used:b']);
  });
});
