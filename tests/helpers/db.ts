import { prisma } from '../../src/config/prisma';

/**
 * Deja la base de datos limpia entre tests (restaura también los bigserial).
 * Todos los archivos comparten la misma DB de test; `fileParallelism: false`
 * evita que dos TRUNCATE se pisen.
 */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE refresh_tokens, agents, containers, nodes, login_attempts, users RESTART IDENTITY CASCADE',
  );
}

/**
 * Extrae el SQLSTATE de un error de Prisma/Postgres. Prisma suele envolver el
 * error nativo en `meta.code` (p. ej. 23503), pero también aceptamos que venga
 * en `code` o en el mensaje para no acoplar los tests a una versión concreta.
 */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
    cause?: { code?: unknown };
  };

  if (typeof candidate.meta?.code === 'string' && /^\d{5}$/.test(candidate.meta.code)) {
    return candidate.meta.code;
  }
  if (typeof candidate.code === 'string' && /^\d{5}$/.test(candidate.code)) {
    return candidate.code;
  }
  if (typeof candidate.cause?.code === 'string' && /^\d{5}$/.test(candidate.cause.code)) {
    return candidate.cause.code;
  }

  const match = /(?:code|SQLSTATE)\s*[:=]?\s*"?([0-9]{5})"?/i.exec(
    String(candidate.message ?? ''),
  );
  return match?.[1];
}
