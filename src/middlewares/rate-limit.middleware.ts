import type { RequestHandler } from 'express';
import { prisma } from '../config/prisma';
import { rateLimited } from '../utils/errors';

/** 5 fallos por (ip + email) en 15 minutos. */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export const readEmailFromBody = (body: unknown): string => {
  if (typeof body !== 'object' || body === null) return '';
  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
};

/**
 * Rate limit respaldado en Postgres (tabla login_attempts), no en memoria: si
 * mañana hay más de una instancia, el contador es compartido.
 *
 * Sólo cuenta fallos dentro de la ventana; un login exitoso los borra en
 * auth.service (reset del contador para esa combinación).
 */
export const loginRateLimit: RequestHandler = (req, res, next) => {
  const ip = req.ip ?? '0.0.0.0';
  const email = readEmailFromBody(req.body);

  // Sin email no hay clave de rate limit; la validación de Zod responderá 400.
  if (!email) {
    next();
    return;
  }

  const since = new Date(Date.now() - WINDOW_MS);

  prisma.loginAttempt
    .count({
      where: { ip, email, successAt: null, createdAt: { gte: since } },
    })
    .then((failures) => {
      if (failures >= MAX_FAILURES) {
        res.setHeader('Retry-After', Math.ceil(WINDOW_MS / 1000));
        next(rateLimited());
        return;
      }
      next();
    })
    .catch(next);
};
