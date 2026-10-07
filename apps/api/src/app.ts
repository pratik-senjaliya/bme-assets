import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { config } from './lib/config';
import { errorHandler, notFound } from './lib/errors';
import { v1 } from './routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', v1);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
