import type { TicketStore, TicketStoreSetOptions } from '../../src/modules/tickets/ticket.service';

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Fake mínimo de Redis para los tests de tickets. No hay Redis en CI todavía;
 * el contrato que importa (SET NX, TTL, claves) se verifica aquí. El servicio
 * real solo necesita implementar `TicketStore`.
 */
export class FakeRedis implements TicketStore {
  private readonly data = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private purge(): void {
    const current = this.now();
    for (const [key, entry] of this.data) {
      if (entry.expiresAt <= current) this.data.delete(key);
    }
  }

  async set(
    key: string,
    value: string,
    options: TicketStoreSetOptions,
  ): Promise<'OK' | null> {
    this.purge();
    if (options.NX && this.data.has(key)) return null;
    this.data.set(key, {
      value,
      expiresAt: this.now() + options.EX * 1000,
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.purge();
    return this.data.get(key)?.value ?? null;
  }

  async ttl(key: string): Promise<number> {
    this.purge();
    const entry = this.data.get(key);
    if (!entry) return -2;
    return Math.ceil((entry.expiresAt - this.now()) / 1000);
  }

  async keys(pattern: string): Promise<string[]> {
    this.purge();
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    return [...this.data.keys()].filter((key) => regex.test(key));
  }

  /** Solo para inspección en tests; no forma parte de `TicketStore`. */
  entries(): Array<{ key: string; value: string; ttl: number }> {
    this.purge();
    return [...this.data.entries()].map(([key, entry]) => ({
      key,
      value: entry.value,
      ttl: Math.ceil((entry.expiresAt - this.now()) / 1000),
    }));
  }
}
