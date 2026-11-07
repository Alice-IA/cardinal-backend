import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 no captura rechazos de funciones async: sin esto, un `await` que
 * falla deja el request colgado hasta el timeout. Envuelve y delega a next().
 */
export const asyncHandler = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler => {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
};
