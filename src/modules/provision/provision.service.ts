import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { env } from '../../config/env';
import { decryptToken, encryptToken } from '../../utils/crypto';
import { nodeUnavailable, notFound } from '../../utils/errors';
import { normalizeProvisionError, type AgentFactory } from './agent-factory';
import type {
  ManagerCallback,
  ManagerJobStatus,
  OrphanContainer,
  SandboxManagerClient,
} from './manager-client';

/**
 * Orquestación del aprovisionamiento en el BACKEND (fuente de verdad).
 *
 * Flujo:
 *   enqueueProvision  → INSERT provisioning + setImmediate(runProvision)
 *   runProvision      → POST al manager (202) y espera el callback
 *   onManagerCallback → escribe conexión + crea el agente (3 intentos)
 *   reconcileOnStartup→ recupera filas tras un reinicio del backend/manager
 *
 * Dos contadores SEPARADOS (corrección 1):
 *   - provision_attempts: fallos del MANAGER (runProvision).
 *   - agent_creation_attempts: intentos de createAgent (onManagerCallback).
 * Así tres fallos del agente no parecen tres fallos del manager y no se borra
 * un contenedor sano.
 *
 * Cola: `setImmediate` + `Map` de locks en memoria. Suficiente para UN proceso;
 * con réplicas hay que mover la cola y los locks a Redis (ver README).
 */

export interface ProvisionDeps {
  prisma: PrismaClient;
  manager: SandboxManagerClient;
  agentFactory: AgentFactory;
  encryptionKey: Buffer;
  logger: Logger;
  systemPrompt: string;
  now?: () => Date;
}

export interface ReconcileReport {
  recovered: number;
  failed: number;
  orphaned: number;
}

/** Filas a recuperar al arrancar (el manager perdió su Map en memoria). */
export const RECONCILABLE_STATUSES = ['provisioning', 'agent_failed'] as const;

const MAX_MANAGER_ATTEMPTS = 3;
const MAX_AGENT_ATTEMPTS = 3;
/** Backoff en memoria: 1 s, 4 s, 16 s. */
const BACKOFF_MS = [1_000, 4_000, 16_000] as const;

/** Lock en memoria por jobId: evita doble ejecución dentro del proceso. */
const inFlight = new Map<string, Promise<void>>();

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeCode(code: string | undefined): string | undefined {
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : undefined;
}

function logProvisionError(
  deps: ProvisionDeps,
  context: Record<string, unknown>,
  error: unknown,
  message: string,
): void {
  const normalized = normalizeProvisionError(error);
  deps.logger.error({ ...context, ...normalized }, message);
}

/**
 * Paso 1 del registro: inserta la fila y encola el trabajo. NO espera al
 * manager, por eso puede responder en <100 ms.
 */
export async function enqueueProvision(
  userId: string,
  deps: ProvisionDeps,
): Promise<{ jobId: string }> {
  const jobId = randomUUID();

  // El token son 32 bytes crudos. El hash que viaja al manager es SIEMPRE
  // sha256(bytes crudos) en hex de 64; nunca sobre base64 ni sobre hex.
  const tokenBytes = randomBytes(32);
  const tokenString = tokenBytes.toString('base64url');
  const tokenSha256 = sha256Hex(tokenBytes);
  void tokenSha256; // runProvision lo recalcula desde el ciphertext

  const node = await deps.prisma.node.findFirst({
    where: { status: 'up' },
    orderBy: { id: 'asc' },
  });
  if (!node) throw nodeUnavailable();

  await deps.prisma.container.create({
    data: {
      id: randomUUID(), // sandboxId público (containers.id)
      userId,
      jobId,
      status: 'provisioning',
      nodeId: node.id,
      tokenCiphertext: encryptToken(tokenString, deps.encryptionKey),
      provider: 'docker',
      transport: 'ws',
    },
  });

  setImmediate(() => {
    void runProvision(jobId, deps).catch((error: unknown) => {
      logProvisionError(deps, { jobId }, error, 'fallo no controlado en runProvision');
    });
  });

  return { jobId };
}

/**
 * Un intento contra el manager. Si falla, incrementa SOLO provision_attempts y
 * programa el siguiente intento con backoff (1 s / 4 s / 16 s).
 */
export async function runProvision(jobId: string, deps: ProvisionDeps): Promise<void> {
  const running = inFlight.get(jobId);
  if (running) {
    await running.catch(() => {
      // El intento en curso ya registró su error; no se propaga al llamante.
    });
    return;
  }

  const task = runProvisionOnce(jobId, deps).finally(() => {
    inFlight.delete(jobId);
  });
  inFlight.set(jobId, task);
  await task;
}

async function runProvisionOnce(jobId: string, deps: ProvisionDeps): Promise<void> {
  const row = await deps.prisma.container.findUnique({ where: { jobId } });
  if (!row || row.status !== 'provisioning') return;

  if (!row.tokenCiphertext) {
    await markProvisionError(
      row.id,
      'TOKEN_MISSING',
      'La fila de provisión no tiene token_ciphertext',
      deps,
    );
    return;
  }

  // Claim best-effort: el Map cubre un proceso; este UPDATE evita que otro
  // proceso que ya movió la fila (error o callback) vuelva a llamar al manager.
  const claimed = await deps.prisma.container.updateMany({
    where: { jobId, status: 'provisioning' },
    data: { provisionErrorCode: row.provisionErrorCode },
  });
  if (claimed.count === 0) return;

  let tokenString: string;
  try {
    tokenString = decryptToken(row.tokenCiphertext, deps.encryptionKey);
  } catch (error) {
    const normalized = normalizeProvisionError(error);
    await markProvisionError(row.id, 'TOKEN_DECRYPT_FAILED', normalized.message, deps);
    return;
  }

  const tokenBytes = Buffer.from(tokenString, 'base64url');
  if (tokenBytes.length !== 32) {
    await markProvisionError(
      row.id,
      'TOKEN_INVALID',
      `El token descifrado no tiene 32 bytes (${tokenBytes.length})`,
      deps,
    );
    return;
  }

  let status: number;
  try {
    ({ status } = await deps.manager.provision({
      jobId,
      sandboxId: row.id,
      userId: row.userId,
      tokenSha256: sha256Hex(tokenBytes),
    }));
  } catch (error) {
    await handleManagerFailure(row.id, jobId, error, deps);
    return;
  }

  if (status !== 202) {
    await handleManagerFailure(
      row.id,
      jobId,
      new Error(`manager respondió ${status} en POST /provision`),
      deps,
    );
  }
}

async function handleManagerFailure(
  containerId: string,
  jobId: string,
  error: unknown,
  deps: ProvisionDeps,
): Promise<void> {
  const { message } = normalizeProvisionError(error);

  const updated = await deps.prisma.container.update({
    where: { id: containerId },
    data: {
      provisionAttempts: { increment: 1 },
      provisionError: message,
      provisionErrorCode: 'MANAGER_UNAVAILABLE',
    },
    select: { provisionAttempts: true },
  });

  if (updated.provisionAttempts >= MAX_MANAGER_ATTEMPTS) {
    await deps.prisma.container.update({
      where: { id: containerId },
      data: {
        status: 'error',
        // El CHECK de la DB exige diagnóstico cuando status='error'.
        errorMessage: message,
        provisionError: message,
        provisionErrorCode: 'MANAGER_UNAVAILABLE',
      },
    });
    return;
  }

  const delay =
    BACKOFF_MS[updated.provisionAttempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
  const timer = setTimeout(() => {
    void runProvision(jobId, deps).catch((retryError: unknown) => {
      logProvisionError(deps, { jobId }, retryError, 'reintento de provisión falló');
    });
  }, delay);
  timer.unref?.();
}

async function markProvisionError(
  containerId: string,
  code: string,
  message: string,
  deps: ProvisionDeps,
): Promise<void> {
  await deps.prisma.container.update({
    where: { id: containerId },
    data: {
      status: 'error',
      provisionErrorCode: code,
      provisionError: message,
      errorMessage: message,
    },
  });
}

/**
 * Callback del manager. Idempotente: si la fila no existe o ya salió de
 * `provisioning`, responde sin tocar nada.
 */
export async function onManagerCallback(
  payload: ManagerCallback,
  deps: ProvisionDeps,
): Promise<void> {
  const row = await deps.prisma.container.findUnique({ where: { jobId: payload.jobId } });
  if (!row || row.status !== 'provisioning') return;

  if (!payload.ok) {
    const code = sanitizeCode(payload.code) ?? 'PROVISION_FAILED';
    const { message } = normalizeProvisionError({
      code,
      message: payload.message ?? code,
    });

    await deps.prisma.container.updateMany({
      where: { id: row.id, status: 'provisioning' },
      data: {
        status: 'error',
        provisionErrorCode: code,
        provisionError: message,
        errorMessage: message,
      },
    });
    return;
  }

  const transport = payload.transport ?? row.transport ?? 'ws';
  const internalHost = payload.internalHost ?? null;
  const port = payload.port ?? null;
  // El callback no trae tlsServername: en wss el SNI es el host interno.
  const tlsServername = transport === 'wss' ? internalHost : null;

  // Escritura condicional: dos callbacks concurrentes solo crean un agente.
  const claimed = await deps.prisma.container.updateMany({
    where: { id: row.id, status: 'provisioning' },
    data: {
      status: 'running',
      internalHost,
      containerPort: port,
      transport,
      tlsServername,
      containerId: payload.containerId ?? null,
      provisionError: null,
      provisionErrorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count === 0) return;

  if (internalHost === null || port === null) {
    await markAgentFailed(
      row.id,
      'El callback ok=true no trajo internalHost/port',
      deps,
    );
    return;
  }

  await createAgentWithRetries(
    {
      containerId: row.id,
      userId: row.userId,
      tokenCiphertext: row.tokenCiphertext,
    },
    { baseUrl: `${transport}://${internalHost}:${port}` },
    deps,
  );
}

interface AgentTarget {
  containerId: string;
  userId: string;
  tokenCiphertext: string | null;
}

/**
 * Reintenta SOLO el agente: 3 intentos con 1 s / 4 s / 16 s. Cada intento
 * incrementa agent_creation_attempts. Al agotarse marca agent_failed y NO
 * borra el contenedor (el borrado/recreación los dispara el retry con jobId
 * nuevo, decisión C).
 */
async function createAgentWithRetries(
  target: AgentTarget,
  connection: { baseUrl: string },
  deps: ProvisionDeps,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS; attempt += 1) {
    await deps.prisma.container.update({
      where: { id: target.containerId },
      data: { agentCreationAttempts: { increment: 1 } },
    });

    try {
      if (!target.tokenCiphertext) {
        throw new Error('La fila de provisión no tiene token_ciphertext');
      }
      const token = decryptToken(target.tokenCiphertext, deps.encryptionKey);

      const { agentId } = await deps.agentFactory.create({
        baseUrl: connection.baseUrl,
        token,
        name: env.AGENT_NAME,
        systemPrompt: deps.systemPrompt,
      });

      await deps.prisma.agent.create({
        data: {
          agentId,
          containerId: target.containerId,
          userId: target.userId,
          agentName: env.AGENT_NAME,
          isPrimary: true,
        },
      });

      await deps.prisma.container.update({
        where: { id: target.containerId },
        data: {
          status: 'running',
          provisionError: null,
          provisionErrorCode: null,
          errorMessage: null,
        },
      });
      return;
    } catch (error) {
      const normalized = normalizeProvisionError(error);

      if (attempt < MAX_AGENT_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
        continue;
      }

      await deps.prisma.container.update({
        where: { id: target.containerId },
        data: {
          status: 'agent_failed',
          provisionErrorCode: 'AGENT_CREATION_FAILED',
          provisionError: normalized.message,
        },
      });
      deps.logger.warn(
        {
          containerId: target.containerId,
          code: normalized.code,
          attempts: MAX_AGENT_ATTEMPTS,
        },
        'no se pudo crear el agente tras 3 intentos',
      );
      return;
    }
  }
}

async function markAgentFailed(
  containerId: string,
  message: string,
  deps: ProvisionDeps,
): Promise<void> {
  const { message: normalized } = normalizeProvisionError(new Error(message));
  await deps.prisma.container.update({
    where: { id: containerId },
    data: {
      status: 'agent_failed',
      provisionErrorCode: 'AGENT_CREATION_FAILED',
      provisionError: normalized,
    },
  });
}

/**
 * Decisión C: jobId nuevo + token regenerado para recrear contenedor y agente.
 * Se actualiza la MISMA fila (el sandboxId no cambia); el jobId anterior deja
 * de existir, así que un callback tardío de ese job se ignora.
 */
export async function retryProvision(
  jobId: string,
  deps: ProvisionDeps,
): Promise<{ jobId: string }> {
  const row = await deps.prisma.container.findUnique({ where: { jobId } });
  if (!row) throw notFound('Provisión no encontrada');

  const newJobId = randomUUID();
  const tokenBytes = randomBytes(32);
  const tokenString = tokenBytes.toString('base64url');
  const tokenSha256 = sha256Hex(tokenBytes);
  void tokenSha256; // runProvision lo recalcula desde el ciphertext

  const tokenCiphertext = encryptToken(tokenString, deps.encryptionKey);

  await deps.prisma.$transaction([
    // El contenedor se recrea: el agente anterior (si existía) deja de valer.
    deps.prisma.agent.deleteMany({ where: { containerId: row.id } }),
    deps.prisma.container.update({
      where: { id: row.id },
      data: {
        jobId: newJobId,
        status: 'provisioning',
        tokenCiphertext,
        provisionAttempts: 0,
        agentCreationAttempts: 0,
        provisionError: null,
        provisionErrorCode: null,
        errorMessage: null,
        internalHost: null,
        containerPort: null,
        containerId: null,
        tlsServername: null,
      },
    }),
  ]);

  setImmediate(() => {
    void runProvision(newJobId, deps).catch((error: unknown) => {
      logProvisionError(deps, { jobId: newJobId }, error, 'fallo en retry de provisión');
    });
  });

  return { jobId: newJobId };
}

/**
 * Reconciliación al arrancar. El manager guarda sus jobs en un Map en memoria
 * con TTL 1 h: tras un reinicio del manager (o del backend entre el 202 y el
 * callback) la fila se queda en `provisioning` y hay que resolverla aquí.
 */
export async function reconcileOnStartup(deps: ProvisionDeps): Promise<ReconcileReport> {
  const rows = await deps.prisma.container.findMany({
    where: { status: { in: [...RECONCILABLE_STATUSES] } },
  });

  let recovered = 0;
  let failed = 0;
  let orphaned = 0;

  for (const row of rows) {
    if (!row.jobId) {
      await markProvisionError(
        row.id,
        'JOB_MISSING',
        'La fila reconcilable no tiene job_id',
        deps,
      );
      failed += 1;
      continue;
    }

    let job: ManagerJobStatus;
    try {
      job = await deps.manager.get(row.jobId);
    } catch (error) {
      // El manager no responde: no se degrada la fila; se reintenta al próximo
      // arranque (el job puede seguir vivo).
      const normalized = normalizeProvisionError(error);
      deps.logger.warn(
        { jobId: row.jobId, code: normalized.code },
        'no se pudo consultar el manager al reconciliar; se deja para el próximo arranque',
      );
      continue;
    }

    if (job.status === 'ready') {
      const transport = job.transport ?? row.transport ?? 'ws';
      const internalHost = job.internalHost ?? row.internalHost;
      const port = job.port ?? row.containerPort;
      const tlsServername =
        transport === 'wss' ? internalHost : row.tlsServername;

      await deps.prisma.container.update({
        where: { id: row.id },
        data: {
          status: 'running',
          internalHost,
          containerPort: port,
          transport,
          tlsServername,
          containerId: job.containerId ?? row.containerId,
          provisionError: null,
          provisionErrorCode: null,
          errorMessage: null,
        },
      });

      if (internalHost === null || port === null) {
        await markAgentFailed(row.id, 'El manager no devolvió internalHost/port', deps);
        failed += 1;
        continue;
      }

      await createAgentWithRetries(
        {
          containerId: row.id,
          userId: row.userId,
          tokenCiphertext: row.tokenCiphertext,
        },
        { baseUrl: `${transport}://${internalHost}:${port}` },
        deps,
      );
      recovered += 1;
      continue;
    }

    if (job.status === 'failed') {
      const code = sanitizeCode(job.code) ?? 'PROVISION_FAILED';
      const { message } = normalizeProvisionError({ code, message: job.message ?? code });
      await deps.prisma.container.update({
        where: { id: row.id },
        data: {
          status: 'error',
          provisionErrorCode: code,
          provisionError: message,
          errorMessage: message,
        },
      });
      failed += 1;
      continue;
    }

    if (job.status === 'unknown') {
      // El manager reinició y perdió el job. Si el contenedor sigue existiendo
      // (label alice.jobId), se re-encola; si no, la fila quedó huérfana.
      let orphans: OrphanContainer[] = [];
      try {
        orphans = await deps.manager.listOrphans();
      } catch {
        orphans = [];
      }

      const orphan = orphans.find((item) => item.labels['alice.jobId'] === row.jobId);
      if (orphan) {
        await runProvision(row.jobId, deps);
        orphaned += 1;
      } else {
        await markProvisionError(
          row.id,
          'JOB_LOST',
          'El manager no conoce el job y no hay contenedor huérfano con ese jobId',
          deps,
        );
        failed += 1;
      }
      continue;
    }

    // pending / running: el manager sigue trabajando; se espera su callback.
    deps.logger.info(
      { jobId: row.jobId, status: job.status },
      'job en curso durante la reconciliación; se deja para el callback',
    );
  }

  const report: ReconcileReport = { recovered, failed, orphaned };
  // Solo agregados y jobIds: nunca tokens ni ciphertext.
  deps.logger.info(report, 'reconciliación de provisiones completada');
  return report;
}
