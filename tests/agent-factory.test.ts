import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentOnSandbox,
  normalizeProvisionError,
  type AgentSdkClient,
  type AgentSdkOptions,
  type CreateAgentInput,
} from '../src/modules/provision/agent-factory';
import {
  loadSystemPrompt,
  resolveSystemPromptPath,
} from '../src/modules/provision/system-prompt';

/**
 * Contrato del AgentFactory.
 *
 * - Se usa el SDK con backend:'remote', url y authToken (nunca se abre un
 *   app-server local ni se inventa otro transporte).
 * - `systemPrompt` es el prompt COMPLETO; `persona` está deprecado y no se usa.
 * - `close()` se llama incluso si createAgent lanza.
 * - La persona sale de `assets/alice-persona.md` byte a byte; sin placeholder.
 */

class RecordingSdk implements AgentSdkClient {
  static options: AgentSdkOptions[] = [];
  static createArgs: Array<{ name?: string; systemPrompt?: string }> = [];
  static closeCalls = 0;
  static failCreate = false;

  constructor(options: AgentSdkOptions) {
    RecordingSdk.options.push(options);
  }

  async createAgent(options: { name?: string; systemPrompt?: string }): Promise<string> {
    RecordingSdk.createArgs.push(options);
    if (RecordingSdk.failCreate) throw new Error('createAgent falló');
    return 'agent-recording-1';
  }

  async close(): Promise<void> {
    RecordingSdk.closeCalls += 1;
  }
}

class FakeWebSocket {}

const input: CreateAgentInput = {
  baseUrl: 'ws://sandbox-alice:4500',
  token: 'capability-token-de-prueba',
  name: 'Alice',
  systemPrompt: 'prompt de prueba',
};

beforeEach(() => {
  RecordingSdk.options = [];
  RecordingSdk.createArgs = [];
  RecordingSdk.closeCalls = 0;
  RecordingSdk.failCreate = false;
});

describe('createAgentOnSandbox', () => {
  it('construye el cliente con backend remote, url, authToken y el WebSocket inyectado', async () => {
    await createAgentOnSandbox(input, { sdk: RecordingSdk, WebSocket: FakeWebSocket });

    expect(RecordingSdk.options).toHaveLength(1);
    const options = RecordingSdk.options[0]!;
    expect(options.backend).toBe('remote');
    expect(options.url).toBe(input.baseUrl);
    expect(options.authToken).toBe(input.token);
    expect(options.WebSocket).toBe(FakeWebSocket);
  });

  it('llama createAgent({name, systemPrompt}) y NO pasa persona', async () => {
    await createAgentOnSandbox(input, { sdk: RecordingSdk });

    expect(RecordingSdk.createArgs).toHaveLength(1);
    const args = RecordingSdk.createArgs[0]!;
    expect(args.name).toBe('Alice');
    expect(args.systemPrompt).toBe(input.systemPrompt);
    expect(args).not.toHaveProperty('persona');
    expect(Object.keys(args).sort()).toEqual(['name', 'systemPrompt']);
  });

  it('el systemPrompt es byte a byte el contenido de assets/alice-persona.md', async () => {
    const persona = readFileSync(join(process.cwd(), 'assets', 'alice-persona.md'), 'utf8');

    await createAgentOnSandbox(
      { ...input, systemPrompt: persona },
      { sdk: RecordingSdk },
    );

    const received = RecordingSdk.createArgs[0]!.systemPrompt!;
    expect(received).toBe(persona);
    expect(
      Buffer.from(received, 'utf8').equals(Buffer.from(persona, 'utf8')),
      'los bytes deben coincidir',
    ).toBe(true);

    // Y el cargador real del repo devuelve exactamente el mismo contenido.
    expect(loadSystemPrompt()).toBe(persona);
    expect(resolveSystemPromptPath()).toBe(
      join(process.cwd(), 'assets', 'alice-persona.md'),
    );
  });

  it('cierra el cliente incluso si createAgent lanza', async () => {
    RecordingSdk.failCreate = true;

    await expect(createAgentOnSandbox(input, { sdk: RecordingSdk })).rejects.toThrow(
      'createAgent falló',
    );
    expect(RecordingSdk.closeCalls, 'close() debe ejecutarse en finally').toBe(1);
  });
});

describe('system prompt', () => {
  it('sin AGENT_SYSTEM_PROMPT_PATH válido falla explícitamente, sin placeholder', () => {
    expect(() => loadSystemPrompt('assets/no-existe-persona.md')).toThrow(
      /AGENT_SYSTEM_PROMPT_PATH/,
    );

    let caught: unknown;
    try {
      loadSystemPrompt('assets/no-existe-persona.md');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain('You are Alice');
  });
});

describe('normalizeProvisionError', () => {
  it('trunca a 500 chars y elimina authToken, headers, config y url', () => {
    const longMessage = `${'x'.repeat(900)} authToken=SECRETO headers={"x":"H"} config={"k":"C"} url=ws://secreto`;
    const error = Object.assign(new Error(longMessage), {
      code: 'AGENT_CREATION_FAILED',
      authToken: 'SECRETO',
      headers: { x: 'H' },
      config: { k: 'C' },
      url: 'ws://secreto',
    });

    const normalized = normalizeProvisionError(error);

    expect(normalized.code).toBe('AGENT_CREATION_FAILED');
    expect(normalized.message.length).toBeLessThanOrEqual(500);
    expect(normalized.message).not.toContain('SECRETO');
    expect(normalized.message).not.toContain('"H"');
    expect(normalized.message).not.toContain('"C"');
    expect(normalized.message).not.toContain('ws://secreto');
  });
});
