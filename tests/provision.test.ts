import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { buildControlPlaneApp } from '../src/control-plane/app';
import {
  type AgentFactory,
  type CreateAgentInput,
} from '../src/modules/provision/agent-factory';
import {
  type ManagerCallback,
  type ManagerJobStatus,
  type ManagerProvisionRequest,
  type OrphanContainer,
  type SandboxManagerClient,
} from '../src/modules/provision/manager-client';
import {
  enqueueProvision,
  onManagerCallback,
  reconcileOnStartup,
  runProvision,
  type ProvisionDeps,
} from '../src/modules/provision/provision.service';
import { decryptToken, encryptToken } from '../src/utils/crypto';
import { resetDb } from './helpers/db';
import { makeTicketDeps } from './helpers/ticket-deps';

/**
 * Contrato del aprovisionamiento en el backend (el manager se prueba aparte).
 *
 * Reglas que fijan estos tests:
 * - enqueue NO espera al manager (<100 ms); el trabajo corre en background.
 * - el sha256 que recibe el manager es hex de 64 sobre el STRING utf8 del
 *   token (`Authorization: Bearer <token>`), no sobre los 32 bytes crudos.
 * - DOS contadores separados: provision_attempts (manager) y
 *   agent_creation_attempts (createAgent). Tres fallos del agente NO pueden
 *   parecer tres fallos del manager.
 * - el token en claro nunca aparece en logs ni en provision_error.
 */

const ENCRYPTION_KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
const SYSTEM_PROMPT = 'Persona de prueba para el bloque de provision.';

interface FakeManager extends SandboxManagerClient {
  provisionCalls: ManagerProvisionRequest[];
}

function makeManager(
  options: {
    provisionStatuses?: number[];
    get?: ManagerJobStatus;
    orphans?: OrphanContainer[];
  } = {},
): FakeManager {
  const provisionCalls: ManagerProvisionRequest[] = [];
  let calls = 0;

  return {
    provisionCalls,
    provision: vi.fn(async (input: ManagerProvisionRequest) => {
      provisionCalls.push(input);
      const configured = options.provisionStatuses ?? [202];
      const status = configured[Math.min(calls, configured.length - 1)] ?? 202;
      calls += 1;
      return { status };
    }),
    get: vi.fn(async (jobId: string): Promise<ManagerJobStatus> => {
      return options.get ?? { jobId, status: 'unknown' };
    }),
    listOrphans: vi.fn(async () => options.orphans ?? []),
  };
}

interface FakeFactory extends AgentFactory {
  calls: CreateAgentInput[];
}

function makeFactory(outcomes: Array<'ok' | 'fail'> = ['ok']): FakeFactory {
  const calls: CreateAgentInput[] = [];
  let index = 0;

  return {
    calls,
    create: vi.fn(async (input: CreateAgentInput) => {
      calls.push(input);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? 'ok';
      index += 1;
      if (outcome === 'fail') {
        throw new Error('letta caído authToken=SECRETO-QUE-NO-DEBE-VERSE');
      }
      return { agentId: `agent-provision-${calls.length}` };
    }),
  };
}

function makeDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    prisma,
    manager: makeManager(),
    agentFactory: makeFactory(),
    encryptionKey: ENCRYPTION_KEY,
    logger: pino({ level: 'silent' }),
    systemPrompt: SYSTEM_PROMPT,
    ...overrides,
  };
}

let userId: string;
let nodeId: string;

beforeEach(async () => {
  await resetDb();
  const user = await prisma.user.create({
    data: {
      email: `provision-${randomUUID()}@example.com`,
      passwordHash: 'test-only-not-a-real-hash',
    },
  });
  userId = user.id;

  const node = await prisma.node.create({
    data: { id: `node-${randomUUID()}`, host: '127.0.0.1', port: 9, status: 'up' },
  });
  nodeId = node.id;
});

afterEach(() => {
  vi.useRealTimers();
});

interface SeededContainer {
  rowId: string;
  jobId: string;
  tokenString: string;
  tokenBytes: Buffer;
  tokenCiphertext: string;
}

async function seedContainer(
  options: {
    jobId?: string;
    status?: string;
    tokenString?: string;
    internalHost?: string;
    containerPort?: number;
    containerId?: string;
    agentCreationAttempts?: number;
  } = {},
): Promise<SeededContainer> {
  const tokenString = options.tokenString ?? randomBytes(32).toString('base64url');
  const tokenBytes = Buffer.from(tokenString, 'base64url');
  const tokenCiphertext = encryptToken(tokenString, ENCRYPTION_KEY);

  const row = await prisma.container.create({
    data: {
      id: randomUUID(),
      userId,
      jobId: options.jobId ?? randomUUID(),
      status: options.status ?? 'provisioning',
      nodeId,
      tokenCiphertext,
      ...(options.internalHost === undefined ? {} : { internalHost: options.internalHost }),
      ...(options.containerPort === undefined ? {} : { containerPort: options.containerPort }),
      ...(options.containerId === undefined ? {} : { containerId: options.containerId }),
      ...(options.agentCreationAttempts === undefined
        ? {}
        : { agentCreationAttempts: options.agentCreationAttempts }),
    },
  });

  return {
    rowId: row.id,
    jobId: row.jobId!,
    tokenString,
    tokenBytes,
    tokenCiphertext,
  };
}

function sha256HexOfString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('enqueueProvision', () => {
  it('crea la fila provisioning y devuelve jobId en <100 ms sin esperar al manager', async () => {
    const manager = makeManager();
    const deps = makeDeps({ manager });

    const started = performance.now();
    const { jobId } = await enqueueProvision(userId, deps);
    const elapsed = performance.now() - started;

    expect(elapsed, 'enqueueProvision debe ser rápido (<100 ms)').toBeLessThan(100);
    expect(manager.provision, 'el manager no se llama dentro de la request').not.toHaveBeenCalled();

    const row = await prisma.container.findUnique({ where: { jobId } });
    expect(row, 'debe existir la fila con job_id').not.toBeNull();
    expect(row?.status).toBe('provisioning');
    expect(row?.tokenCiphertext, 'token_ciphertext se escribe antes de llamar al manager').toBeTruthy();
  });

  it('el string descifrado tiene 43 chars y su sha256 utf8 (64) coincide con el del manager', async () => {
    const manager = makeManager();
    const deps = makeDeps({ manager });

    const { jobId } = await enqueueProvision(userId, deps);

    await vi.waitFor(() => expect(manager.provision).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    const row = await prisma.container.findUnique({ where: { jobId } });
    const tokenString = decryptToken(row!.tokenCiphertext!, ENCRYPTION_KEY);

    expect(tokenString, 'el token es el string de 43 chars (base64url)').toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(
      Buffer.from(tokenString, 'base64url'),
      'el string decodifica a 32 bytes',
    ).toHaveLength(32);

    const received = manager.provisionCalls[0]!.tokenSha256;
    expect(received, 'sha256 hex de 64 caracteres').toMatch(/^[0-9a-f]{64}$/);
    expect(received, 'sha256 del STRING utf8, no de los bytes crudos').toBe(
      sha256HexOfString(tokenString),
    );
    expect(manager.provisionCalls[0]!.sandboxId, 'sandboxId es containers.id').toBe(row!.id);
  });

  it('integración cruzada: descifrar la BD → string S y sha256(utf8 S) === hash del manager', async () => {
    const manager = makeManager();
    const deps = makeDeps({ manager });

    const { jobId } = await enqueueProvision(userId, deps);
    await vi.waitFor(() => expect(manager.provision).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    const row = await prisma.container.findUnique({ where: { jobId } });
    const storedString = decryptToken(row!.tokenCiphertext!, ENCRYPTION_KEY);
    const expected = createHash('sha256').update(storedString, 'utf8').digest('hex');

    expect(manager.provisionCalls[0]!.tokenSha256).toBe(expected);
    // Regresión de la corrección: NO es el hash de los 32 bytes crudos.
    expect(expected).not.toBe(
      createHash('sha256').update(Buffer.from(storedString, 'base64url')).digest('hex'),
    );
  });
});

describe('runProvision', () => {
  it('con manager 202 el estado sigue provisioning (espera callback)', async () => {
    const seeded = await seedContainer();
    const manager = makeManager({ provisionStatuses: [202] });

    await runProvision(seeded.jobId, makeDeps({ manager }));

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('provisioning');
    expect(row?.provisionAttempts).toBe(0);
    expect(manager.provisionCalls[0]!.jobId).toBe(seeded.jobId);
  });

  it('con manager 503 incrementa provision_attempts y guarda provision_error', async () => {
    vi.useFakeTimers();
    const seeded = await seedContainer();
    const manager = makeManager({ provisionStatuses: [503] });

    await runProvision(seeded.jobId, makeDeps({ manager }));

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.provisionAttempts).toBe(1);
    expect(row?.provisionError, 'el error queda persistido').toBeTruthy();
    expect(row?.status, 'un fallo no final no marca error').toBe('provisioning');
  });

  it('tres fallos del manager dejan status=error y MANAGER_UNAVAILABLE', async () => {
    vi.useFakeTimers();
    const seeded = await seedContainer();
    const manager = makeManager({ provisionStatuses: [503, 503, 503] });
    const deps = makeDeps({ manager });

    await runProvision(seeded.jobId, deps);
    await runProvision(seeded.jobId, deps);
    await runProvision(seeded.jobId, deps);

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('error');
    expect(row?.provisionAttempts).toBe(3);
    expect(row?.provisionErrorCode).toBe('MANAGER_UNAVAILABLE');
    expect(row?.provisionError).toBeTruthy();
  });
});

describe('onManagerCallback', () => {
  it('ok=false deja status=error con code y message', async () => {
    const seeded = await seedContainer();
    const deps = makeDeps();

    await onManagerCallback(
      {
        jobId: seeded.jobId,
        ok: false,
        code: 'DEPLOY_FAILED',
        message: 'docker compose up falló',
      },
      deps,
    );

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('error');
    expect(row?.provisionErrorCode).toBe('DEPLOY_FAILED');
    expect(row?.provisionError).toContain('docker compose up falló');
    expect(row?.errorMessage, 'el CHECK de la DB exige diagnóstico').toBeTruthy();
  });

  it('ok=true escribe la conexión y crea el agente primario', async () => {
    const seeded = await seedContainer();
    const factory = makeFactory(['ok']);
    const deps = makeDeps({ agentFactory: factory });

    const payload: ManagerCallback = {
      jobId: seeded.jobId,
      ok: true,
      containerName: 'alice-container',
      internalHost: 'sandbox-alice',
      port: 4500,
      transport: 'wss',
      containerId: 'docker-container-1',
    };

    await onManagerCallback(payload, deps);

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('running');
    expect(row?.internalHost).toBe('sandbox-alice');
    expect(row?.containerPort).toBe(4500);
    expect(row?.transport).toBe('wss');
    expect(row?.tlsServername, 'en wss el SNI es el host interno').toBe('sandbox-alice');
    expect(row?.containerId).toBe('docker-container-1');

    const agents = await prisma.agent.findMany({ where: { containerId: seeded.rowId } });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.isPrimary).toBe(true);
    expect(factory.calls[0]!.baseUrl).toBe('wss://sandbox-alice:4500');
    expect(factory.calls[0]!.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(factory.calls[0]!.token).toBe(seeded.tokenString);
  });

  it('un callback duplicado es idempotente: un solo agente', async () => {
    const seeded = await seedContainer();
    const factory = makeFactory(['ok']);
    const deps = makeDeps({ agentFactory: factory });
    const payload: ManagerCallback = {
      jobId: seeded.jobId,
      ok: true,
      internalHost: 'sandbox-alice',
      port: 4500,
      transport: 'ws',
      containerId: 'docker-container-1',
    };

    await onManagerCallback(payload, deps);
    await onManagerCallback(payload, deps);

    const agents = await prisma.agent.findMany({ where: { containerId: seeded.rowId } });
    expect(agents).toHaveLength(1);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('un callback de una fila ya running se ignora (200)', async () => {
    const seeded = await seedContainer({
      status: 'running',
      internalHost: 'host-original',
      containerPort: 41000,
      containerId: 'cid-original',
    });
    const factory = makeFactory(['ok']);
    const deps = makeDeps({ agentFactory: factory });

    await onManagerCallback(
      {
        jobId: seeded.jobId,
        ok: true,
        internalHost: 'host-nuevo',
        port: 4500,
        transport: 'ws',
        containerId: 'cid-nuevo',
      },
      deps,
    );

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.internalHost).toBe('host-original');
    expect(row?.containerPort).toBe(41000);
    expect(factory.create).not.toHaveBeenCalled();
  });
});

describe('contadores separados (corrección 1)', () => {
  it('2 fallos del agente y acierto al 3º: running, provision_attempts=0, agent_creation_attempts=3', async () => {
    const seeded = await seedContainer();
    const factory = makeFactory(['fail', 'fail', 'ok']);
    const deps = makeDeps({ agentFactory: factory });

    await onManagerCallback(
      {
        jobId: seeded.jobId,
        ok: true,
        internalHost: 'sandbox-alice',
        port: 4500,
        transport: 'ws',
        containerId: 'cid',
      },
      deps,
    );

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('running');
    expect(row?.provisionAttempts, 'el manager respondió 202: no cuenta como fallo').toBe(0);
    expect(row?.agentCreationAttempts).toBe(3);

    const agents = await prisma.agent.findMany({ where: { containerId: seeded.rowId } });
    expect(agents).toHaveLength(1);
  });

  it('3 fallos del agente: agent_failed, contenedor intacto y AGENT_CREATION_FAILED', async () => {
    const seeded = await seedContainer();
    const factory = makeFactory(['fail', 'fail', 'fail']);
    const deps = makeDeps({ agentFactory: factory });

    await onManagerCallback(
      {
        jobId: seeded.jobId,
        ok: true,
        internalHost: 'sandbox-alice',
        port: 4500,
        transport: 'ws',
        containerId: 'cid',
      },
      deps,
    );

    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row, 'el contenedor NO se borra (decisión C)').not.toBeNull();
    expect(row?.status).toBe('agent_failed');
    expect(row?.agentCreationAttempts).toBe(3);
    expect(row?.provisionAttempts).toBe(0);
    expect(row?.provisionErrorCode).toBe('AGENT_CREATION_FAILED');
    expect(row?.provisionError).toBeTruthy();

    const agents = await prisma.agent.findMany({ where: { containerId: seeded.rowId } });
    expect(agents).toHaveLength(0);
  });
});

describe('POST /internal/provision/:jobId/retry', () => {
  it('genera jobId nuevo, regenera token y pone los dos contadores a 0', async () => {
    const seeded = await seedContainer({ status: 'agent_failed', agentCreationAttempts: 3 });
    const manager = makeManager();
    const deps = makeDeps({ manager, agentFactory: makeFactory(['ok']) });
    const app = buildControlPlaneApp({ ticketDeps: makeTicketDeps(), provisionDeps: deps });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/provision/${seeded.jobId}/retry`,
        headers: { 'x-internal-token': env.INTERNAL_TOKEN },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json() as { jobId: string };
      expect(body.jobId).not.toBe(seeded.jobId);

      const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
      expect(row?.jobId).toBe(body.jobId);
      expect(row?.status).toBe('provisioning');
      expect(row?.provisionAttempts).toBe(0);
      expect(row?.agentCreationAttempts).toBe(0);
      expect(row?.tokenCiphertext).not.toBe(seeded.tokenCiphertext);
      expect(decryptToken(row!.tokenCiphertext!, ENCRYPTION_KEY)).not.toBe(seeded.tokenString);
    } finally {
      await app.close();
    }
  });
});

describe('reconcileOnStartup', () => {
  it('fila provisioning + manager ready crea el agente y pasa a running', async () => {
    const seeded = await seedContainer();
    const factory = makeFactory(['ok']);
    const manager = makeManager({
      get: {
        jobId: seeded.jobId,
        status: 'ready',
        internalHost: 'sandbox-alice',
        port: 4500,
        transport: 'ws',
        containerId: 'cid-recovered',
      },
    });

    const report = await reconcileOnStartup(makeDeps({ manager, agentFactory: factory }));

    expect(report.recovered).toBe(1);
    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('running');
    expect(row?.internalHost).toBe('sandbox-alice');
    expect(row?.containerId).toBe('cid-recovered');
    expect(await prisma.agent.count({ where: { containerId: seeded.rowId } })).toBe(1);
  });

  it('fila provisioning + manager unknown + huérfano con ese jobId reencola el job', async () => {
    const seeded = await seedContainer();
    const manager = makeManager({
      get: { jobId: seeded.jobId, status: 'unknown' },
      orphans: [
        {
          name: 'alice-container',
          labels: { 'alice.jobId': seeded.jobId, 'alice.userId': userId },
          containerId: 'cid-orphan',
          status: 'running',
        },
      ],
    });

    const report = await reconcileOnStartup(makeDeps({ manager }));

    expect(report.orphaned).toBe(1);
    expect(manager.provisionCalls[0]!.jobId).toBe(seeded.jobId);
    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status, 're-encolar no lo marca error').toBe('provisioning');
  });

  it('fila provisioning + manager failed deja status=error', async () => {
    const seeded = await seedContainer();
    const manager = makeManager({
      get: { jobId: seeded.jobId, status: 'failed', code: 'READY_TIMEOUT', message: 'sin readyz' },
    });

    const report = await reconcileOnStartup(makeDeps({ manager }));

    expect(report.failed).toBe(1);
    const row = await prisma.container.findUnique({ where: { id: seeded.rowId } });
    expect(row?.status).toBe('error');
    expect(row?.provisionErrorCode).toBe('READY_TIMEOUT');
  });

  it('no loguea el token en claro (ni truncado)', async () => {
    const tokenString = randomBytes(32).toString('base64url');
    const seeded = await seedContainer({ tokenString });
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    });
    const logger = pino({ level: 'debug' }, stream);
    const manager = makeManager({
      get: {
        jobId: seeded.jobId,
        status: 'ready',
        internalHost: 'sandbox-alice',
        port: 4500,
        transport: 'ws',
        containerId: 'cid',
      },
    });

    await reconcileOnStartup(makeDeps({ manager, logger }));

    const joined = logs.join('\n');
    expect(joined, 'el token completo no aparece').not.toContain(tokenString);
    expect(joined, 'el token truncado tampoco').not.toContain(tokenString.slice(0, 12));
    expect(logs.join('\n'), 'el log sí debe registrar el reporte').toContain('reconcil');
  });
});

describe('esquema: container_port sin UNIQUE', () => {
  it('dos containers con container_port=4500 e internal_host distinto conviven (INSERT y UPDATE)', async () => {
    const base = { userId, nodeId, status: 'running' as const };

    const first = await prisma.container.create({
      data: {
        ...base,
        id: randomUUID(),
        jobId: randomUUID(),
        containerPort: 4500,
        internalHost: 'sandbox-a',
      },
    });
    const second = await prisma.container.create({
      data: {
        ...base,
        id: randomUUID(),
        jobId: randomUUID(),
        containerPort: 4501,
        internalHost: 'sandbox-b',
      },
    });

    expect(first.containerPort).toBe(4500);

    // UPDATE del puerto al mismo valor: antes violaba el UNIQUE.
    const updated = await prisma.container.update({
      where: { id: second.id },
      data: { containerPort: 4500 },
    });

    expect(updated.containerPort).toBe(4500);
    expect(await prisma.container.count({ where: { containerPort: 4500 } })).toBe(2);
  });
});
