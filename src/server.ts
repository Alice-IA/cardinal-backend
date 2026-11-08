import { createServer, type Server } from 'node:http';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import Redis from 'ioredis';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { buildControlPlaneApp } from './control-plane/app';
import { createRedisTicketStore } from './modules/tickets/store.redis';
import type { TicketDeps } from './modules/tickets/ticket.service';
import { logger } from './utils/logger';

/**
 * Arranque de producción: UNA sola instancia HTTP sirve dos superficies.
 *
 * - `/internal/*` → app Fastify del control plane (API del gateway).
 * - resto → app Express de auth (legacy; se portará a Fastify en otra tarea).
 *
 * Montaje: caso (a) de la pregunta de diseño. Hay un único `http.Server`
 * escuchando en `PORT`; su listener decide por path. Fastify NO abre otro
 * puerto: `controlPlane.server` es su `http.Server` interno (sin `listen`), y
 * emitir `'request'` sobre él ejecuta el handler real de Fastify. Express se
 * invoca como handler normal de Node. Por eso el reparto es determinista:
 *
 *   /internal/...  -> Fastify
 *   cualquier otra -> Express (incluido su 404 por defecto)
 *
 * NO es SO_REUSEPORT ni dos servidores compitiendo por el puerto.
 */

export interface BuiltHttpServer {
  /** Servidor HTTP único; el test/producción decide cuándo hacer `listen`. */
  server: Server;
  controlPlane: FastifyInstance;
  /** Cierra el socket y, después, los hooks de Fastify. */
  close(): Promise<void>;
}

function isInternalPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  return url === '/internal' || url.startsWith('/internal/');
}

/**
 * Construye el servidor real (Express + Fastify) sin abrir puerto.
 *
 * Se inyectan `ticketDeps` para que el test de integración use FakeRedis y para
 * que el arranque de producción sea el único que instancia ioredis.
 */
export async function buildHttpServer(
  ticketDeps: TicketDeps,
  controlPlaneLogger?: FastifyServerOptions['loggerInstance'],
): Promise<BuiltHttpServer> {
  const controlPlane = buildControlPlaneApp(
    controlPlaneLogger ? { ticketDeps, logger: controlPlaneLogger } : { ticketDeps },
  );
  await controlPlane.ready();

  const server = createServer((request, response) => {
    if (isInternalPath(request.url)) {
      // Fastify escucha en `controlPlane.server`; emitir 'request' reutiliza su
      // router/errores/parsers sin abrir un segundo socket.
      controlPlane.server.emit('request', request, response);
      return;
    }
    // Express es un handler `(req, res)` de Node: recibe el resto de rutas.
    app(request, response);
  });

  return {
    server,
    controlPlane,
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await controlPlane.close();
    },
  };
}

/**
 * Arranque de producción: conecta Redis, construye `ticketDeps` y escucha.
 * `now` se deja en su default (Date.now).
 */
export async function startServer(): Promise<void> {
  const redis = new Redis(env.REDIS_URL);

  // ioredis emite 'error' como evento: sin listener, Node lo convierte en un
  // throw. No se loguea `env.REDIS_URL` porque puede contener credenciales.
  redis.on('error', (error: Error) => {
    logger.error({ err: error }, 'error de conexión con Redis');
  });

  const ticketDeps: TicketDeps = {
    store: createRedisTicketStore(redis),
    secret: env.WS_TICKET_SECRET,
  };

  const built = await buildHttpServer(ticketDeps, logger);
  built.server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'servidor escuchando');
  });

  registerShutdown(built, redis);
}

function registerShutdown(built: BuiltHttpServer, redis: Redis): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'apagando');

    built.server.close(() => {
      // Todo se cierra en paralelo; `allSettled` evita que un fallo de apagado
      // (p. ej. Redis ya caído) impida cerrar Prisma.
      Promise.allSettled([
        built.controlPlane.close(),
        redis.quit(),
        prisma.$disconnect(),
      ]).finally(() => process.exit(0));
    });

    // Si algún request queda colgado, no esperamos para siempre.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// `node dist/server.js` y `tsx src/server.ts` deben arrancar; importarlo desde
// un test NO debe abrir un puerto ni conectar Redis.
const isMainModule =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMainModule) {
  void startServer().catch((error: unknown) => {
    logger.error({ err: error }, 'no se pudo arrancar el servidor');
    process.exit(1);
  });
}
