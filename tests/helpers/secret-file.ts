import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SecretFile {
  path: string;
  secret: Buffer;
}

/**
 * Escribe un secreto de 32 bytes en un archivo temporal y devuelve la ruta.
 * El gateway debe leer el secreto de la ruta (`ws_secret_path`), no de la DB.
 */
export async function createSecretFile(secret: Buffer = randomBytes(32)): Promise<SecretFile> {
  const dir = await mkdtemp(join(tmpdir(), 'cardinal-ws-secret-'));
  const path = join(dir, 'ws_secret');
  await writeFile(path, secret);
  return { path, secret };
}
