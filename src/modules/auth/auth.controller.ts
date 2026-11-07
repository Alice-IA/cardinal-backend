import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';
import { getCurrentUser, login, register } from './auth.service';
import { loginSchema, registerSchema } from './auth.schema';
import {
  RefreshRaceLostError,
  revokeRefreshToken,
  rotateRefreshToken,
} from './token.service';

/**
 * Cookie única de refresh.
 *
 * path=/auth (y no /auth/refresh) porque /auth/logout también necesita recibirla
 * para poder revocar el token en la base de datos. Con path=/auth/refresh el
 * navegador no la manda a logout y el servidor no tendría nada que revocar.
 */
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_PATH = '/auth';

const baseCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: REFRESH_COOKIE_PATH,
});

/** Sin cookie-parser: el header se parsea a mano (una sola cookie nos importa). */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

const setRefreshCookie = (res: Response, token: string, expiresAt: Date): void => {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
};

/** Mismo path y mismas flags que al crearla, si no el navegador no la borra. */
const clearRefreshCookie = (res: Response): void => {
  res.clearCookie(REFRESH_COOKIE, baseCookieOptions());
};

export async function registerController(req: Request, res: Response): Promise<void> {
  const input = registerSchema.parse(req.body);
  const user = await register(input);
  res.status(201).json({ user });
}

export async function loginController(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);

  // Nota: cualquier refresh token que venga en la cookie se ignora a propósito.
  // Login siempre abre una familia nueva y no revoca la entrante, para que un
  // doble submit no tumbe la sesión que ya estaba viva en otro dispositivo.
  const result = await login(input, req.ip ?? '0.0.0.0');

  setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
  res.status(200).json({ accessToken: result.accessToken });
}

export async function refreshController(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, REFRESH_COOKIE);

  if (!token) {
    clearRefreshCookie(res);
    res.status(401).json({ error: { code: 'TOKEN_INVALID', message: 'Token inválido' } });
    return;
  }

  try {
    const rotated = await rotateRefreshToken(token);
    setRefreshCookie(res, rotated.refreshToken, rotated.expiresAt);
    res.status(200).json({ accessToken: rotated.accessToken });
  } catch (error) {
    // La carrera benigna no borra la cookie: el ganador acaba de escribir una
    // válida y un clear tardío la tiraría.
    if (!(error instanceof RefreshRaceLostError)) {
      clearRefreshCookie(res);
    }
    throw error;
  }
}

export async function logoutController(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, REFRESH_COOKIE);
  if (token) {
    await revokeRefreshToken(token);
  }
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function meController(req: Request, res: Response): Promise<void> {
  // `authenticate` garantiza req.user antes de llegar aquí.
  const user = await getCurrentUser(req.user!.id);
  res.status(200).json({ user });
}
