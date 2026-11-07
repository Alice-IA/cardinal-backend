import { prisma } from '../../src/config/prisma';

/** Deja la base de datos limpia entre tests (restaura también los bigserial). */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE refresh_tokens, agents, containers, login_attempts, users RESTART IDENTITY CASCADE',
  );
}
