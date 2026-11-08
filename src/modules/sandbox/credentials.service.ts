import { prisma } from '../../config/prisma';
import { decryptToken } from '../../utils/crypto';
import { sandboxNotFound } from '../../utils/errors';

/**
 * Entrega del capability token de un sandbox a cardinal-gateway.
 *
 * La fila se busca por PK (`containers.id` es el `sandboxId` público del
 * gateway). Un contenedor sin `token_ciphertext` es un sandbox provisionado
 * antes de la migración: no hay token que entregar, así que el contrato dice
 * 404 SANDBOX_NOT_FOUND (no 500).
 *
 * `decryptToken` lanza `TokenDecryptionError` si el ciphertext está corrupto;
 * la ruta lo traduce a 500 INTERNAL_ERROR y registra el fallo sin ciphertext ni
 * clave.
 */
export async function readCapabilityToken(sandboxId: string, key: Buffer): Promise<string> {
  const container = await prisma.container.findUnique({
    where: { id: sandboxId },
    select: { tokenCiphertext: true },
  });

  if (!container?.tokenCiphertext) {
    throw sandboxNotFound();
  }

  return decryptToken(container.tokenCiphertext, key);
}
