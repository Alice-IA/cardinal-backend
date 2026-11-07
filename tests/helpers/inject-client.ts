import type { FastifyInstance } from 'fastify';

/**
 * Cliente mínimo sobre `app.inject()` para reemplazar a supertest en la
 * migración a Fastify sin cambiar ningún assert.
 *
 * Soporta un cookie jar opcional (equivalente a `request.agent` de supertest)
 * y expone `headers['set-cookie']` siempre como array.
 */

export const REFRESH_COOKIE = 'refresh_token';

export interface InjectResponse {
  status: number;
  body: any;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

class InjectRequest implements PromiseLike<InjectResponse> {
  private readonly headers: Record<string, string> = {};
  private payload: unknown;

  constructor(
    private readonly app: FastifyInstance,
    private readonly method: Method,
    private readonly url: string,
    private readonly cookies: Map<string, string> | null,
  ) {}

  set(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  send(body: unknown): this {
    this.payload = body;
    return this;
  }

  private async execute(): Promise<InjectResponse> {
    const headers = { ...this.headers };
    if (this.cookies && this.cookies.size > 0) {
      headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    let payload: string | Buffer | undefined;
    if (this.payload !== undefined) {
      if (typeof this.payload === 'string' || Buffer.isBuffer(this.payload)) {
        payload = this.payload;
      } else {
        payload = JSON.stringify(this.payload);
        headers['content-type'] ??= 'application/json';
      }
    }

    const response = await this.app.inject({
      method: this.method,
      url: this.url,
      headers,
      payload,
    });

    const setCookies = normalizeSetCookie(
      response.headers['set-cookie'] as string | string[] | undefined,
    );
    if (this.cookies) {
      for (const raw of setCookies) {
        const [pair] = raw.split(';');
        const separator = pair?.indexOf('=') ?? -1;
        if (!pair || separator < 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value.length === 0 || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }

    let body: any = null;
    if (response.body.length > 0) {
      try {
        body = JSON.parse(response.body);
      } catch {
        body = response.body;
      }
    }

    return {
      status: response.statusCode,
      body,
      headers: { ...response.headers, 'set-cookie': setCookies },
      text: response.body,
    };
  }

  then<TResult1 = InjectResponse, TResult2 = never>(
    onfulfilled?: ((value: InjectResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function normalizeSetCookie(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface InjectClient {
  get(url: string): InjectRequest;
  post(url: string): InjectRequest;
  put(url: string): InjectRequest;
  patch(url: string): InjectRequest;
  delete(url: string): InjectRequest;
}

export interface ClientOptions {
  /** Mantiene y reenvía cookies como `request.agent` de supertest. */
  cookieJar?: boolean;
}

export function createClient(app: FastifyInstance, options: ClientOptions = {}): InjectClient {
  const cookies = options.cookieJar ? new Map<string, string>() : null;
  const request = (method: Method, url: string) =>
    new InjectRequest(app, method, url, cookies);

  return {
    get: (url) => request('GET', url),
    post: (url) => request('POST', url),
    put: (url) => request('PUT', url),
    patch: (url) => request('PATCH', url),
    delete: (url) => request('DELETE', url),
  };
}

// ── Helpers de cookies copiados de tests/helpers/client.ts (supertest) ──

export function refreshCookieValue(res: InjectResponse): string | undefined {
  const cookie = normalizeSetCookie(
    res.headers['set-cookie'] as string | string[] | undefined,
  ).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!cookie) return undefined;
  const value = cookie.slice(REFRESH_COOKIE.length + 1).split(';')[0];
  return value && value.length > 0 ? value : undefined;
}

export function refreshCookieHeader(res: InjectResponse): string {
  const value = refreshCookieValue(res);
  if (!value) throw new Error('La respuesta no incluyó la cookie de refresh');
  return `${REFRESH_COOKIE}=${value}`;
}

export function refreshCookieRaw(res: InjectResponse): string | undefined {
  return normalizeSetCookie(
    res.headers['set-cookie'] as string | string[] | undefined,
  ).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
}

export const CREDENTIALS = {
  email: 'ada@example.com',
  password: 'una-contrasena-larga-123',
  name: 'Ada',
} as const;

/** Versión inject de `tests/helpers/client.ts#registerAndLogin`. */
export function makeAuthHelpers(app: FastifyInstance) {
  const api = () => createClient(app);
  const agent = () => createClient(app, { cookieJar: true });

  const registerAndLogin = async (
    overrides: Partial<{ email: string; password: string; name: string }> = {},
  ): Promise<{ accessToken: string; refreshCookie: string; userId: string }> => {
    const credentials = { ...CREDENTIALS, ...overrides };

    const registerRes = await api().post('/auth/register').send(credentials);
    if (registerRes.status !== 201) {
      throw new Error(
        `register falló: ${registerRes.status} ${JSON.stringify(registerRes.body)}`,
      );
    }

    const loginRes = await api().post('/auth/login').send({
      email: credentials.email,
      password: credentials.password,
    });
    if (loginRes.status !== 200) {
      throw new Error(`login falló: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
    }

    return {
      accessToken: loginRes.body.accessToken as string,
      refreshCookie: refreshCookieHeader(loginRes),
      userId: registerRes.body.user.id as string,
    };
  };

  return { api, agent, registerAndLogin };
}
