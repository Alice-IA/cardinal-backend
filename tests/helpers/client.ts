import request from 'supertest';
import type { Response } from 'supertest';
import { app } from '../../src/app';

export const REFRESH_COOKIE = 'refresh_token';

/** Cliente sin estado (cada request es independiente). */
export const api = () => request(app);

/** Cliente con cookie jar, respeta Path=/auth. */
export const agent = () => request.agent(app);

const setCookieHeader = (res: Response): string[] => {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
};

/** Valor (no el header completo) de la cookie de refresh en una respuesta. */
export function refreshCookieValue(res: Response): string | undefined {
  const cookie = setCookieHeader(res).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!cookie) return undefined;
  const value = cookie.slice(REFRESH_COOKIE.length + 1).split(';')[0];
  return value && value.length > 0 ? value : undefined;
}

export function refreshCookieHeader(res: Response): string {
  const value = refreshCookieValue(res);
  if (!value) throw new Error('La respuesta no incluyó la cookie de refresh');
  return `${REFRESH_COOKIE}=${value}`;
}

export function refreshCookieRaw(res: Response): string | undefined {
  return setCookieHeader(res).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
}

export const CREDENTIALS = {
  email: 'ada@example.com',
  password: 'una-contrasena-larga-123',
  name: 'Ada',
} as const;

/** Registra + loguea y devuelve el access token y la cookie de refresh. */
export async function registerAndLogin(
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<{ accessToken: string; refreshCookie: string; userId: string }> {
  const credentials = { ...CREDENTIALS, ...overrides };

  const registerRes = await api().post('/auth/register').send(credentials);
  if (registerRes.status !== 201) {
    throw new Error(`register falló: ${registerRes.status} ${JSON.stringify(registerRes.body)}`);
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
}
