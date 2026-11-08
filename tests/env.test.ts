import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `src/config/env.ts` valida con zod y, si falta una variable, escribe el
 * detalle en stderr y hace `process.exit(1)`. Por eso "sin INTERNAL_TOKEN el
 * proceso no arranca" se comprueba en un proceso hijo: importar el módulo
 * dentro del worker de vitest mataría la corrida, que es justo el
 * comportamiento que se quiere fijar.
 *
 * El hijo corre en un directorio sin `.env` para que dotenv no reponga la
 * variable ausente.
 */

// vitest corre desde la raíz del repo (igual que global-setup).
const repoRoot = process.cwd();
const envModuleUrl = pathToFileURL(join(repoRoot, 'src', 'config', 'env.ts')).href;

let sandboxDir: string;

beforeAll(() => {
  // node_modules está gitignored y garantizado; el directorio no tiene .env.
  sandboxDir = mkdtempSync(join(repoRoot, 'node_modules', 'env-check-'));
});

afterAll(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

function runEnvModuleWithout(variable: string): { status: number | null; stderr: string } {
  const childEnv = { ...process.env };
  delete childEnv[variable];

  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--eval', `import(${JSON.stringify(envModuleUrl)})`],
      { cwd: sandboxDir, env: childEnv, stdio: 'pipe', encoding: 'utf8' },
    );
    return { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number | null; stderr?: string };
    return { status: failure.status ?? null, stderr: failure.stderr ?? '' };
  }
}

describe('config/env', () => {
  it('sin INTERNAL_TOKEN el proceso no arranca', () => {
    const result = runEnvModuleWithout('INTERNAL_TOKEN');

    expect(result.status, 'un deploy sin INTERNAL_TOKEN debe salir con código 1').toBe(1);
    expect(result.stderr, 'el error debe nombrar la variable que falta').toContain(
      'INTERNAL_TOKEN es obligatorio',
    );
  });

  it('sin WS_TICKET_SECRET el proceso no arranca', () => {
    const result = runEnvModuleWithout('WS_TICKET_SECRET');

    expect(result.status, 'un deploy sin WS_TICKET_SECRET debe salir con código 1').toBe(1);
    expect(result.stderr, 'el error debe nombrar la variable que falta').toContain(
      'WS_TICKET_SECRET es obligatorio',
    );
  });

  it('sin TOKEN_ENCRYPTION_KEY el proceso no arranca', () => {
    const result = runEnvModuleWithout('TOKEN_ENCRYPTION_KEY');

    expect(result.status, 'un deploy sin TOKEN_ENCRYPTION_KEY debe salir con código 1').toBe(1);
    expect(result.stderr, 'el error debe nombrar la variable que falta').toContain(
      'TOKEN_ENCRYPTION_KEY es obligatorio',
    );
  });
});
