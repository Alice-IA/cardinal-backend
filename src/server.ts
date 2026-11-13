import { createServer, type Server } from 'node:http';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import Redis from 'ioredis';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { buildControlPlaneApp } from './control-plane/app';
import { defaultAgentFactory } from './modules/provision/agent-factory';
import { createManagerClient } from './modules/provision/manager-client';
import {
  reconcileOnStartup,
  type ProvisionDeps,
} from './modules/provision/provision.service';
import { loadSystemPrompt } from './modules/provision/system-prompt';
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

/** Sondas que ejecuta `/readyz`. Inyectables para que los tests no toquen DB/Redis. */
export interface HealthChecks {
  db(): Promise<unknown>;
  redis(): Promise<unknown>;
}

/**
 * Timeout por sonda. Las dos corren en paralelo, así que `/readyz` tarda como
 * mucho esto (2 s), no la suma.
 */
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/**
 * Ejecuta una sonda con timeout y devuelve true/false. Nunca propaga el error:
 * un fallo de DB o Redis es un 503, no un 500.
 *
 * El error NO se loguea completo a propósito: el mensaje de ioredis incluye la
 * URL de Redis, que puede llevar credenciales. Solo se registra el nombre de la
 * sonda y, si existe, un `code` corto.
 */
async function runProbe(
  check: 'db' | 'redis',
  probe: () => Promise<unknown>,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${check}_timeout`)), timeoutMs);
      }),
    ]);
    return true;
  } catch (error: unknown) {
    const rawCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code: unknown }).code
        : undefined;
    logger.warn(
      { check, code: typeof rawCode === 'string' ? rawCode : undefined },
      'sonda de readiness falló',
    );
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Registra `/healthz` y `/readyz` en la app Express.
 *
 * - `/healthz`: liveness puro, SIN auth. Docker y Caddy lo llaman sin token y
 *   no debe depender de DB ni Redis.
 * - `/readyz`: readiness real (DB + Redis). 503 si cualquiera falla.
 *
 * Es idempotente: `app` es un singleton de módulo y `buildHttpServer` se llama
 * varias veces en tests. Las sondas se leen en cada request, así que una
 * segunda llamada solo actualiza las dependencias.
 */
const healthRoutesRegistered = new WeakSet<object>();
let activeHealthChecks: HealthChecks | undefined;

function registerHealthRoutes(target: typeof app, checks: HealthChecks): void {
  activeHealthChecks = checks;
  if (healthRoutesRegistered.has(target)) return;
  healthRoutesRegistered.add(target);

  target.get('/healthz', (_request, response) => {
    response.status(200).json({ ok: true });
  });

  target.get('/readyz', async (_request, response) => {
    const current = activeHealthChecks;
    if (current === undefined) {
      response.status(503).json({ ok: false, checks: { db: false, redis: false } });
      return;
    }

    const [db, redisOk] = await Promise.all([
      runProbe('db', () => current.db()),
      runProbe('redis', () => current.redis()),
    ]);
    const ok = db && redisOk;
    response.status(ok ? 200 : 503).json({ ok, checks: { db, redis: redisOk } });
  });
}

/** Sondas por defecto cuando no se inyectan (tests que no tocan /readyz). */
function defaultHealthChecks(): HealthChecks {
  return {
    db: () => prisma.$queryRaw`SELECT 1`,
    redis: () => Promise.reject(new Error('redis no configurado')),
  };
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
  provisionDeps?: ProvisionDeps,
  healthChecks: HealthChecks = defaultHealthChecks(),
): Promise<BuiltHttpServer> {
  // Antes de crear el socket: /healthz y /readyz viven en Express y deben
  // existir antes de que llegue la primera request (y antes del 404 por defecto).
  registerHealthRoutes(app, healthChecks);

  const controlPlane = buildControlPlaneApp(
    controlPlaneLogger
      ? { ticketDeps, provisionDeps, logger: controlPlaneLogger }
      : { ticketDeps, provisionDeps },
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
  // La persona de Alice es un archivo del repo y es OBLIGATORIA: si no existe,
  // el proceso no arranca y no sirve provisiones (no hay placeholder). Solo se
  // loguea la longitud, nunca el contenido.
  const systemPrompt = loadSystemPrompt(env.AGENT_SYSTEM_PROMPT_PATH);
  logger.info({ chars: systemPrompt.length }, 'persona de Alice cargada');

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

  const provisionDeps: ProvisionDeps = {
    prisma,
    manager: createManagerClient({
      baseUrl: env.MANAGER_URL,
      internalToken: env.INTERNAL_TOKEN,
      timeoutMs: env.PROVISION_TIMEOUT_MS,
    }),
    agentFactory: defaultAgentFactory,
    encryptionKey: Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'),
    logger,
    systemPrompt,
  };

  const built = await buildHttpServer(ticketDeps, logger, provisionDeps, {
    // Readiness real: la DB y el Redis de producción, no un puerto abierto.
    db: () => prisma.$queryRaw`SELECT 1`,
    redis: () => redis.ping(),
  });
  built.server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'servidor escuchando');
  });

  // Reconciliación al arrancar: cubre el backend muerto entre el 202 y el
  // callback, y el manager que perdió su Map en memoria. No bloquea el listen.
  void reconcileOnStartup(provisionDeps)
    .then((report) => {
      logger.info(report, 'reconciliación inicial completada');
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'falló la reconciliación inicial');
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
