/**
 * Creación del agente primario DENTRO de un sandbox, vía SDK de Letta.
 *
 * El SDK se carga de forma perezosa con `import()` porque el paquete es ESM y
 * este repo compila a CommonJS. En tests se inyecta un SDK falso, así que el
 * módulo real no se carga en la suite.
 *
 * No se usa `persona` (deprecado en CreateAgentOptions): el prompt completo
 * viaja en `systemPrompt`.
 */

import WebSocket from 'ws';

export interface CreateAgentInput {
  /** ws:// o wss:// del app-server del sandbox. */
  baseUrl: string;
  /** Capability token en claro; nunca se loguea. */
  token: string;
  name: string;
  systemPrompt: string;
}

/** Superficie mínima del cliente del SDK que usa este módulo. */
export interface AgentSdkClient {
  createAgent(options: { name?: string; systemPrompt?: string }): Promise<string>;
  close(): Promise<void>;
}

export interface AgentSdkOptions {
  backend: 'remote';
  url: string;
  authToken?: string;
  WebSocket?: unknown;
}

export type AgentSdkConstructor = new (options: AgentSdkOptions) => AgentSdkClient;

export interface AgentFactoryDeps {
  /** Inyectable en tests; en producción se carga el SDK real. */
  sdk?: AgentSdkConstructor;
  /** Inyectable en tests (por defecto el constructor de `ws`). */
  WebSocket?: unknown;
}

export interface AgentFactory {
  create(input: CreateAgentInput): Promise<{ agentId: string }>;
}

async function loadDefaultSdk(): Promise<AgentSdkConstructor> {
  const module = await import('@letta-ai/letta-agent-sdk');
  return module.LettaAgentClient as unknown as AgentSdkConstructor;
}

/**
 * Crea el agente remoto sobre el app-server del sandbox.
 *
 * El cliente se cierra SIEMPRE (también si createAgent lanza): un socket WS
 * abierto por intento vivo sería una fuga en el reintento del agente.
 */
export async function createAgentOnSandbox(
  input: CreateAgentInput,
  deps: AgentFactoryDeps = {},
): Promise<{ agentId: string }> {
  const Sdk = deps.sdk ?? (await loadDefaultSdk());
  const socket = deps.WebSocket ?? WebSocket;

  const client = new Sdk({
    backend: 'remote',
    url: input.baseUrl,
    authToken: input.token,
    WebSocket: socket,
  });

  try {
    const agentId = await client.createAgent({
      name: input.name,
      systemPrompt: input.systemPrompt,
    });
    return { agentId };
  } finally {
    await client.close().catch(() => {
      // Cerrar es best-effort: el fallo de close no debe ocultar el de create.
    });
  }
}

export const defaultAgentFactory: AgentFactory = {
  create: (input) => createAgentOnSandbox(input),
};

/** Máximo de caracteres persistidos en `provision_error`. */
export const MAX_PROVISION_ERROR_MESSAGE = 500;

/**
 * Campos que pueden contener el capability token o material sensible. Se
 * eliminan del mensaje ANTES de truncar; el objeto de error nunca se serializa
 * entero en `provision_error`.
 */
const SENSITIVE_FIELD =
  /["']?\b(authToken|headers|config|url)\b["']?\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|\{[^{}]*\}|\[[^\[\]]*\]|[^\s,;]+)/gi;

function asRecord(error: unknown): Record<string, unknown> | null {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : null;
}

/**
 * Normaliza cualquier excepción antes de persistirla:
 * - `code` estable (solo A-Z0-9_, si no `PROVISION_ERROR`);
 * - `message` sin authToken/headers/config/url y truncado a 500 chars;
 * - nunca stack, nunca el objeto completo.
 */
export function normalizeProvisionError(error: unknown): {
  code: string;
  message: string;
} {
  const record = asRecord(error);

  let rawMessage: string;
  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (record && typeof record.message === 'string') {
    rawMessage = record.message;
  } else if (typeof error === 'string') {
    rawMessage = error;
  } else {
    rawMessage = 'Error de aprovisionamiento';
  }

  const scrubbed = rawMessage.replace(
    SENSITIVE_FIELD,
    (_match, field: string) => `${field}=[REDACTED]`,
  );

  const rawCode = record && typeof record.code === 'string' ? record.code : '';
  const code = /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'PROVISION_ERROR';

  return {
    code,
    message: scrubbed.slice(0, MAX_PROVISION_ERROR_MESSAGE),
  };
}
