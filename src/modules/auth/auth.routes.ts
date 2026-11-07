import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { loginRateLimit } from '../../middlewares/rate-limit.middleware';
import { asyncHandler } from '../../utils/async-handler';
import {
  loginController,
  logoutController,
  meController,
  refreshController,
  registerController,
} from './auth.controller';

export const authRouter = Router();

authRouter.post('/register', asyncHandler(registerController));
authRouter.post('/login', loginRateLimit, asyncHandler(loginController));
authRouter.post('/refresh', asyncHandler(refreshController));
authRouter.post('/logout', asyncHandler(logoutController));
authRouter.get('/me', authenticate, asyncHandler(meController));
