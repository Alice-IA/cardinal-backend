import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorMiddleware } from './middlewares/error.middleware';
import { authRouter } from './modules/auth/auth.routes';
import { httpLogger } from './utils/logger';

export const app = express();

app.disable('x-powered-by');

// Orígenes explícitos + credentials: la cookie de refresh viaja cross-origin.
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  }),
);

app.use(helmet());
app.use(express.json({ limit: '100kb' }));
app.use(httpLogger);

app.use('/auth', authRouter);

app.use(errorMiddleware);
