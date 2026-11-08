import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado del capability token (AES-256-GCM).
 *
 * Formato en la columna TEXT:
 *
 *   base64url( iv(12) || authTag(16) || ciphertext )
 *
 * - IV aleatorio por operación (`randomBytes(12)`); nunca se reutiliza.
 * - El authTag viaja dentro del payload y se verifica al descifrar.
 * - Un payload malformado, truncado o con el tag alterado lanza
 *   `TokenDecryptionError`; nunca se devuelve `null` (un null silencioso
 *   obligaría a cada llamador a inventar su propio manejo del fallo).
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PAYLOAD_BYTES = IV_BYTES + TAG_BYTES;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export class TokenDecryptionError extends Error {
  constructor(message = 'No se pudo descifrar el token') {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

/** La clave es el parámetro más peligroso: nunca se loguea ni se incluye. */
function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new RangeError(
      `La clave de cifrado debe tener exactamente ${KEY_BYTES} bytes`,
    );
  }
}

export function encryptToken(plaintext: string, key: Buffer): string {
  assertKey(key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
}

export function decryptToken(ciphertext: string, key: Buffer): string {
  assertKey(key);

  if (!BASE64URL_RE.test(ciphertext)) {
    throw new TokenDecryptionError();
  }

  const payload = Buffer.from(ciphertext, 'base64url');
  if (payload.length < MIN_PAYLOAD_BYTES) {
    throw new TokenDecryptionError();
  }

  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(IV_BYTES, MIN_PAYLOAD_BYTES);
  const encrypted = payload.subarray(MIN_PAYLOAD_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // Incluye authTag inválido y ciphertext corrupto. El mensaje es genérico a
    // propósito: no debe filtrar el payload ni la clave.
    throw new TokenDecryptionError();
  }
}
