import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { logger } from './utils/logger';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'servidor escuchando');
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'apagando');

  server.close(() => {
    prisma
      .$disconnect()
      .catch((error: unknown) => logger.error({ err: error }, 'fallo al desconectar prisma'))
      .finally(() => process.exit(0));
  });

  // Si algún request queda colgado, no esperamos para siempre.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
