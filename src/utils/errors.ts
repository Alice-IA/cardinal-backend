export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'EMAIL_TAKEN'
  | 'INTERNAL_ERROR'
  // ── Contrato fase 0a (nuevos códigos fijados por el documento) ──
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SANDBOX_NOT_READY'
  | 'NODE_UNAVAILABLE'
  | 'CONNECTION_LIMIT'
  | 'TICKET_INVALID'
  | 'TICKET_EXPIRED'
  | 'TICKET_ALREADY_USED'
  | 'UPSTREAM_ERROR';

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

// ── Helpers nuevos (los stubs todavía no los usan; los tests fijan el código) ──
export const forbidden = (message = 'Operación no permitida') =>
  new AppError('FORBIDDEN', 403, message);

export const notFound = (message = 'Recurso no encontrado') =>
  new AppError('NOT_FOUND', 404, message);

export const sandboxNotReady = () =>
  new AppError('SANDBOX_NOT_READY', 409, 'El sandbox no está listo');

export const nodeUnavailable = () =>
  new AppError('NODE_UNAVAILABLE', 503, 'El nodo no está disponible');

export const connectionLimit = () =>
  new AppError('CONNECTION_LIMIT', 429, 'Ya hay una conexión abierta para este usuario');

export const ticketInvalid = () => new AppError('TICKET_INVALID', 401, 'Ticket inválido');

export const ticketExpired = () => new AppError('TICKET_EXPIRED', 401, 'Ticket expirado');

export const ticketAlreadyUsed = () =>
  new AppError('TICKET_ALREADY_USED', 409, 'El ticket ya fue usado');

export const upstreamError = (message = 'El servicio upstream no respondió') =>
  new AppError('UPSTREAM_ERROR', 502, message);
