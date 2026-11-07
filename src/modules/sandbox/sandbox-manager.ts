/**
 * Aprovisionamiento y ciclo de vida de sandboxes.
 *
 * FASE 0a: solo contrato. Los tests `tests/sandbox-manager.test.ts` usan un
 * `FakeDocker` que registra los comandos; no hay Docker real en CI.
 */

import type { PrismaClient } from '@prisma/client';

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunner {
  run(argv: string[]): Promise<DockerResult>;
}

export interface ProvisionInput {
  userId: string;
  agentId: string;
}

export interface ProvisionResult {
  containerId: string;
  wsSecretPath: string;
}

export interface SandboxManagerOptions {
  docker: DockerRunner;
  prisma: PrismaClient;
  /** Directorio que simula el volumen memfs (en producción, el host mount). */
  memfsRoot: string;
  /** Inyectable para el test de timeout de /readyz con fake timers. */
  checkReady?: (route: { host: string; port: number }) => Promise<boolean>;
  readyTimeoutMs?: number;
  now?: () => number;
}

export interface SandboxManager {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  restart(containerId: string): Promise<void>;
}

export function createSandboxManager(_options: SandboxManagerOptions): SandboxManager {
  const notImplemented = (operation: string) => async (): Promise<never> => {
    throw new Error(`not implemented: SandboxManager.${operation}`);
  };

  return {
    provision: notImplemented('provision'),
    start: notImplemented('start'),
    stop: notImplemented('stop'),
    remove: notImplemented('remove'),
    restart: notImplemented('restart'),
  };
}
