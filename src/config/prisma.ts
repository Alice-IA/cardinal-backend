import { PrismaClient } from '@prisma/client';
import { env } from './env';

/**
 * Singleton de PrismaClient. En desarrollo con recarga en caliente, reutiliza
 * la instancia colgada de globalThis para no abrir un pool por cada recarga.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
