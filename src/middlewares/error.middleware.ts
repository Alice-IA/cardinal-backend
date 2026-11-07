import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import type { ErrorDetail } from '../utils/errors';
import { logger } from '../utils/logger';

const zodDetails = (error: ZodError): ErrorDetail[] =>
  error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
    issue: issue.message,
  }));

const isJsonSyntaxError = (error: unknown): error is SyntaxError & { body: unknown } =>
  error instanceof SyntaxError && 'body' in error;

/**
 * Único punto de salida de errores. Forma garantizada:
 * { error: { code, message, details?: [{ field, issue }] } }
 */
export const errorMiddleware: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    logger.warn(
      { code: error.code, status: error.statusCode, path: req.path },
      'request falló',
    );
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    const details = zodDetails(error);
    logger.warn({ code: 'VALIDATION_ERROR', path: req.path, details }, 'validación falló');
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Datos inválidos', details },
    });
    return;
  }

  if (isJsonSyntaxError(error)) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'JSON inválido',
        details: [{ field: '(body)', issue: 'El cuerpo no es JSON válido' }],
      },
    });
    return;
  }

  logger.error({ err: error, path: req.path }, 'error no controlado');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' },
  });
};
