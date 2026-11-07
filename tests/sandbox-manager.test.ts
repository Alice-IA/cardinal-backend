import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import {
  createSandboxManager,
  type ProvisionResult,
  type SandboxManager,
} from '../src/modules/sandbox/sandbox-manager';
import { resetDb, sqlState } from './helpers/db';
import { FakeDocker } from './helpers/fake-docker';

let docker: FakeDocker;
let manager: SandboxManager;
let memfsRoot: string;
let userId: string;
let nodeId: string;
let agentId: string;

beforeEach(async () => {
  await resetDb();
  memfsRoot = await mkdtemp(join(tmpdir(), 'cardinal-memfs-'));
  docker = new FakeDocker();

  const user = await prisma.user.create({
    data: {
      email: 'sandbox@example.com',
      passwordHash: 'test-only-not-a-real-hash',
      name: 'Sandbox',
    },
  });
  userId = user.id;

  const node = await prisma.node.create({
    data: { id: `node-sandbox-${userId}`, host: '127.0.0.1', port: 9, status: 'up' },
  });
  nodeId = node.id;
  agentId = 'agent-sandbox-1';

  manager = createSandboxManager({
    docker,
    prisma,
    memfsRoot,
    checkReady: async () => true,
    readyTimeoutMs: 90_000,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(memfsRoot, { recursive: true, force: true });
});

describe('SandboxManager.provision', () => {
  it('genera un secreto de 32 bytes y guarda la ruta, no el secreto', async () => {
    const result = await manager.provision({ userId, agentId });
    const container = await prisma.container.findUnique({ where: { id: result.containerId } });

    expect(result.wsSecretPath, 'provision debe devolver la ruta del secreto').toBeTruthy();
    expect(container?.wsSecretPath, 'la DB debe guardar la ruta en ws_secret_path').toBe(
      result.wsSecretPath,
    );

    const secret = await readFile(result.wsSecretPath);
    expect(secret.length, 'el archivo debe contener 32 bytes').toBe(32);

    const serialized = JSON.stringify(result);
    expect(
      serialized,
      'el resultado no debe incluir el contenido del secreto, solo su ruta',
    ).not.toContain(secret.toString('utf8'));
  });

  it('el comando de docker compose up no publica puertos', async () => {
    await manager.provision({ userId, agentId });

    const composeCommand = docker.commands.find(
      (argv) => argv.includes('compose') && argv.includes('up'),
    );
    expect(composeCommand, 'debe existir un docker compose up').toBeDefined();

    const joined = composeCommand!.join(' ');
    expect(joined, 'no debe haber -p (publish)').not.toMatch(/(^|\s)-p(\s|$)/);
    expect(joined, 'no debe haber --publish').not.toContain('--publish');

    const fileIndex = composeCommand!.indexOf('-f');
    expect(fileIndex, 'el compose debe generarse en un archivo (docker compose -f ...)').toBeGreaterThanOrEqual(0);
    const composePath = composeCommand![fileIndex + 1];
    expect(composePath, 'el -f debe ir seguido de la ruta del compose').toBeDefined();

    const compose = await readFile(composePath!, 'utf8');
    expect(compose, 'el compose generado no debe tener una sección ports:').not.toMatch(
      /^\s*ports:/m,
    );
  });

  it('el comando configura ws-auth signed-bearer-token y el archivo de secreto', async () => {
    await manager.provision({ userId, agentId });

    const allCommands = docker.commands.map((argv) => argv.join(' ')).join('\n');
    const composeCommand = docker.commands.find(
      (argv) => argv.includes('compose') && argv.includes('up'),
    );
    const fileIndex = composeCommand?.indexOf('-f') ?? -1;
    const composePath = fileIndex >= 0 ? composeCommand![fileIndex + 1] : undefined;
    const compose = composePath ? await readFile(composePath, 'utf8') : '';
    const configuration = `${allCommands}\n${compose}`;

    expect(configuration, 'falta --ws-auth signed-bearer-token').toContain(
      '--ws-auth signed-bearer-token',
    );
    expect(configuration, 'falta --ws-shared-secret-file').toContain(
      '--ws-shared-secret-file',
    );
  });

  it('es idempotente: dos llamadas no crean dos containers', async () => {
    const first = await manager.provision({ userId, agentId });
    const second = await manager.provision({ userId, agentId });

    expect(second.containerId, 'provision debe devolver el mismo container').toBe(
      first.containerId,
    );
    const containers = await prisma.container.findMany({ where: { userId } });
    expect(containers, 'provision no debe crear un segundo container').toHaveLength(1);
    const upCommands = docker.commandsMatching('compose', 'up');
    expect(upCommands.length, 'no debe ejecutarse un segundo compose up').toBeLessThanOrEqual(1);
  });

  it('si /readyz nunca responde, deja status=error y error_message no nulo', async () => {
    vi.useFakeTimers();
    manager = createSandboxManager({
      docker,
      prisma,
      memfsRoot,
      checkReady: () => new Promise<boolean>(() => {}),
      readyTimeoutMs: 90_000,
    });

    const provisioning = manager
      .provision({ userId, agentId })
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    await vi.advanceTimersByTimeAsync(90_000);

    let result: ProvisionResult | undefined;
    const outcome = await provisioning;
    if (outcome.ok) {
      result = outcome.result;
    }
    // El contrato observable es el estado en DB; el throw o return queda a
    // decisión de la implementación.

    const container = result
      ? await prisma.container.findUnique({ where: { id: result.containerId } })
      : await prisma.container.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });

    expect(container, 'provision debe haber creado la fila del contenedor').not.toBeNull();
    expect(container?.status, 'un /readyz que nunca responde debe dejar status=error').toBe('error');
    expect(container?.errorMessage, 'status=error exige error_message no nulo').toBeTruthy();

    let checkError: unknown;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE containers SET status = 'error', error_message = NULL WHERE id = $1`,
        container!.id,
      );
    } catch (caught) {
      checkError = caught;
    }

    expect(checkError, 'la DB debe rechazar status=error sin error_message').toBeDefined();
    expect(sqlState(checkError), 'el CHECK esperado era 23514').toBe('23514');
  });
});

describe('SandboxManager.remove/restart', () => {
  it('remove es idempotente y borra memfs/<agent_id>/', async () => {
    const result = await manager.provision({ userId, agentId });
    const agentDir = join(memfsRoot, agentId);
    expect(existsSync(agentDir), 'provision debe crear memfs/<agent_id>/').toBe(true);

    await manager.remove(result.containerId);
    expect(existsSync(agentDir), 'remove debe borrar memfs/<agent_id>/').toBe(false);

    await expect(
      manager.remove(result.containerId),
      'un segundo remove no debe fallar (idempotente)',
    ).resolves.toBeUndefined();
  });

  it('restart no espera a que el contenedor esté listo', async () => {
    const result = await manager.provision({ userId, agentId });

    const started = performance.now();
    await manager.restart(result.containerId);
    const elapsed = performance.now() - started;

    expect(elapsed, 'restart debe responder rápido, sin esperar /readyz').toBeLessThan(500);
    const container = await prisma.container.findUnique({ where: { id: result.containerId } });
    expect(
      container?.status,
      'restart no debe marcar running antes de que el contenedor esté listo',
    ).not.toBe('running');
  });
});

// Estos casos necesitan Docker real; no se ejecutan en CI.
it.todo('[docker-real] provision levanta el contenedor y /readyz responde de verdad');
it.todo('[docker-real] el compose no publica puertos en el host');
it.todo('[docker-real] el secreto ws no aparece en docker inspect');
it.todo('[docker-real] remove borra el contenedor y el volumen memfs');
