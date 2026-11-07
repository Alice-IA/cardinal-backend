import pino from 'pino';
import pinoHttp from 'pino-http';
import { env } from '../config/env';

const level =
  env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug';

/**
 * Logger estructurado. La lista de redacción es explícita y defensiva: la regla
 * es no loguear nunca secretos, esto es la red de seguridad si algo se cuela.
 *
 * `pino-http` loguea req/res completos en debug, así que los headers sensibles
 * también están cubiertos aquí.
 */
export const logger = pino({
  level,
  base: { service: 'alice-backend' },
  redact: {
    paths: [
      'password',
      '*.password',
      'newPassword',
      '*.newPassword',
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'passwordHash',
      '*.passwordHash',
      'tokenHash',
      '*.tokenHash',
      'authorization',
      '*.authorization',
      'cookie',
      '*.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      // Secreto backend → gateway: nunca debe aparecer en un access log.
      '["x-internal-token"]',
      'req.headers["x-internal-token"]',
      '*.headers["x-internal-token"]',
    ],
    censor: '[REDACTED]',
  },
});

export const httpLogger = pinoHttp({ logger });
