/**
 * Cliente HTTP del Sandbox Manager (lado backend).
 *
 * El manager es un servicio aparte que habla Docker y NO toca PostgreSQL. El
 * backend sigue siendo la única fuente de verdad del estado; este cliente solo
 * transporta el job y consulta su estado.
 *
 * Autenticación: `X-Internal-Token` (mismo secreto backend↔gateway). El token
 * nunca se loguea ni se incluye en los mensajes de error.
 */

export type ManagerJobState = 'pending' | 'running' | 'ready' | 'failed' | 'unknown';

/** Cuerpo de POST /provision (el manager responde 202). */
export interface ManagerProvisionRequest {
  jobId: string;
  sandboxId: string;
  userId: string;
  /** SHA-256 hex (64) del STRING utf8 que viaja en Authorization: Bearer. */
  tokenSha256: string;
}

/** Callback manager → backend: POST {BACKEND_URL}/internal/provision/ready. */
export interface ManagerCallback {
  jobId: string;
  ok: boolean;
  containerName?: string;
  internalHost?: string;
  port?: number;
  transport?: string;
  containerId?: string;
  code?: string;
  message?: string;
}

/** Respuesta de GET /provision/:jobId. */
export interface ManagerJobStatus {
  jobId: string;
  status: ManagerJobState;
  containerName?: string;
  internalHost?: string;
  port?: number;
  transport?: string;
  containerId?: string;
  code?: string;
  message?: string;
}

/** Contenedor huérfano devuelto por GET /provision/orphans. */
export interface OrphanContainer {
  name: string;
  labels: Record<string, string>;
  containerId: string;
  status: string;
}

export interface SandboxManagerClient {
  /** POST /provision. Devuelve el status HTTP (202 esperado). */
  provision(input: ManagerProvisionRequest): Promise<{ status: number }>;
  /** GET /provision/:jobId. 404 se traduce a `unknown` (el manager reinició). */
  get(jobId: string): Promise<ManagerJobStatus>;
  /** GET /provision/orphans. */
  listOrphans(): Promise<OrphanContainer[]>;
}

export interface ManagerClientOptions {
  baseUrl: string;
  internalToken: string;
  timeoutMs?: number;
  /** Inyectable para tests; por defecto el `fetch` global de Node. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const VALID_STATES: readonly ManagerJobState[] = [
  'pending',
  'running',
  'ready',
  'failed',
  'unknown',
];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asState(value: unknown): ManagerJobState {
  return VALID_STATES.includes(value as ManagerJobState)
    ? (value as ManagerJobState)
    : 'unknown';
}

export function createManagerClient(options: ManagerClientOptions): SandboxManagerClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      return await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-internal-token': options.internalToken,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async provision(input) {
      // No se lee el body: solo importa el status. El token no viaja aquí.
      const response = await request('/provision', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return { status: response.status };
    },

    async get(jobId) {
      const response = await request(`/provision/${encodeURIComponent(jobId)}`, {
        method: 'GET',
      });

      if (response.status === 404) {
        return { jobId, status: 'unknown' };
      }
      if (!response.ok) {
        throw new Error(`manager respondió ${response.status} en GET /provision/:jobId`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      return {
        jobId,
        status: asState(body.status),
        containerName: asString(body.containerName),
        internalHost: asString(body.internalHost),
        port: asNumber(body.port),
        transport: asString(body.transport),
        containerId: asString(body.containerId),
        code: asString(body.code),
        message: asString(body.message),
      };
    },

    async listOrphans() {
      const response = await request('/provision/orphans', { method: 'GET' });
      if (!response.ok) {
        throw new Error(`manager respondió ${response.status} en GET /provision/orphans`);
      }

      const body = (await response.json()) as { containers?: unknown };
      if (!Array.isArray(body.containers)) return [];

      return body.containers
        .map((item): OrphanContainer | null => {
          if (typeof item !== 'object' || item === null) return null;
          const raw = item as Record<string, unknown>;
          const labels =
            typeof raw.labels === 'object' && raw.labels !== null
              ? (raw.labels as Record<string, string>)
              : {};
          // Defensa: el manager solo devuelve contenedores de Alice, pero el
          // cliente no confía en eso para decidir si un job está huérfano.
          if (typeof labels['alice.jobId'] !== 'string') return null;

          return {
            name: String(raw.name ?? ''),
            labels,
            containerId: String(raw.containerId ?? ''),
            status: String(raw.status ?? ''),
          };
        })
        .filter((item): item is OrphanContainer => item !== null);
    },
  };
}
