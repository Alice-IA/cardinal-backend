/**
 * Adaptador `TicketStore` sobre Redis.
 *
 * `RedisLike` es el subconjunto mínimo de `ioredis` que usa el servicio. Se
 * declara aquí (y no se importa el tipo `Redis`) para que los tests puedan
 * inyectar un fake sin acoplarse a ioredis.
 *
 * Sobre el cast: no hace falta. ioredis 5 declara exactamente estas dos
 * sobrecargas para `set` (`'EX'` sola devuelve `'OK'`; con `'NX'` devuelve
 * `'OK' | null`), así que una instancia de `Redis` es asignable a `RedisLike`
 * sin `as`. El adaptador solo traduce las opciones al orden posicional.
 */
import type { TicketStore } from './ticket.service';

export interface RedisLike {
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK'>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export function createRedisTicketStore(client: RedisLike): TicketStore {
  return {
    set(key, value, options) {
      // `consumeTicket` usa NX para reservar el jti de forma atómica: SET NX
      // devuelve null si otro proceso ya lo reservó (segundo consumo → 409).
      if (options.NX) {
        return client.set(key, value, 'EX', options.EX, 'NX');
      }
      return client.set(key, value, 'EX', options.EX);
    },
    get(key) {
      return client.get(key);
    },
    ttl(key) {
      return client.ttl(key);
    },
    keys(pattern) {
      // Solo diagnóstico/tests: `KEYS` es O(N) y bloquea Redis mientras recorre
      // todo el keyspace. Si algún día se usa en un job, debe migrarse a SCAN.
      // En el camino caliente de tickets (`consumeTicket`) no se llama.
      return client.keys(pattern);
    },
  };
}
