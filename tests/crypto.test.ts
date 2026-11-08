import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  TokenDecryptionError,
} from '../src/utils/crypto';

/**
 * Contrato del cifrado en reposo del capability token.
 *
 * Formato: base64url(iv(12) || authTag(16) || ciphertext).
 * El IV es aleatorio por operación y el authTag se verifica al descifrar; un
 * payload manipulado o truncado lanza `TokenDecryptionError` (nunca null).
 */

const KEY = Buffer.alloc(32, 0x42);
const OTHER_KEY = Buffer.alloc(32, 0x43);

const ROUND_TRIP_CASES: Array<[string, string]> = [
  ['cadena vacía', ''],
  ['un carácter', 'a'],
  ['1 KB', 'x'.repeat(1024)],
  ['bytes no ASCII', 'ñandú 🐦 中文 \u0000 fin'],
];

describe('encryptToken / decryptToken', () => {
  it.each(ROUND_TRIP_CASES)('round-trip: %s', (_label, plaintext) => {
    const ciphertext = encryptToken(plaintext, KEY);

    expect(decryptToken(ciphertext, KEY)).toBe(plaintext);
  });

  it('dos cifrados del mismo plaintext producen ciphertexts distintos (IV aleatorio)', () => {
    const first = encryptToken('mismo-token', KEY);
    const second = encryptToken('mismo-token', KEY);

    expect(first, 'el IV debe ser aleatorio por operación').not.toBe(second);
  });

  it('descifrar con otra clave lanza TokenDecryptionError', () => {
    const ciphertext = encryptToken('capability-token', KEY);

    expect(() => decryptToken(ciphertext, OTHER_KEY)).toThrow(TokenDecryptionError);
  });

  it('un byte alterado del ciphertext lanza TokenDecryptionError', () => {
    const ciphertext = encryptToken('capability-token', KEY);
    const payload = Buffer.from(ciphertext, 'base64url');

    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    const tampered = payload.toString('base64url');

    expect(() => decryptToken(tampered, KEY)).toThrow(TokenDecryptionError);
  });

  it('un payload truncado (< 28 bytes) lanza TokenDecryptionError', () => {
    for (const size of [0, 12, 27]) {
      const truncated = Buffer.alloc(size, 0x01).toString('base64url');
      expect(() => decryptToken(truncated, KEY), `payload de ${size} bytes`).toThrow(
        TokenDecryptionError,
      );
    }
  });

  it('una clave de 31 o 33 bytes lanza al llamar', () => {
    const ciphertext = encryptToken('x', KEY);

    expect(() => encryptToken('x', Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => encryptToken('x', Buffer.alloc(33))).toThrow(/32 bytes/);
    expect(() => decryptToken(ciphertext, Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => decryptToken(ciphertext, Buffer.alloc(33))).toThrow(/32 bytes/);
  });

  it('el ciphertext es un string base64url', () => {
    const ciphertext = encryptToken('capability-token', KEY);

    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ciphertext, 'base64url no usa padding').not.toContain('=');
  });
});
