import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../modules/auth/token.service';
import { tokenInvalid } from '../utils/errors';

export type { AuthUser } from '../modules/auth/token.service';

const BEARER_PREFIX = 'Bearer ';

/**
 * Middleware reutilizable: exige `Authorization: Bearer <access token>` y deja
 * el usuario en `req.user`. Cualquier módulo puede montarlo.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    next(tokenInvalid('Falta el access token'));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    next(tokenInvalid('Falta el access token'));
    return;
  }

  verifyAccessToken(token).then(
    (user) => {
      req.user = user;
      next();
    },
    (error: unknown) => next(error),
  );
};
