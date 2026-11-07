export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'EMAIL_TAKEN'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field: string;
  issue: string;
}

/**
 * Error de dominio con forma HTTP. Todo lo que salga por el middleware de
 * errores tiene el shape { error: { code, message, details? } }.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace?.(this, AppError);
  }
}

export const invalidCredentials = () =>
  new AppError('INVALID_CREDENTIALS', 401, 'Credenciales inválidas');

export const emailTaken = () =>
  new AppError('EMAIL_TAKEN', 409, 'No se pudo completar el registro');

export const tokenInvalid = (message = 'Token inválido') =>
  new AppError('TOKEN_INVALID', 401, message);

export const tokenExpired = () => new AppError('TOKEN_EXPIRED', 401, 'Token expirado');

export const rateLimited = () =>
  new AppError('RATE_LIMITED', 429, 'Demasiados intentos. Intenta de nuevo más tarde.');
