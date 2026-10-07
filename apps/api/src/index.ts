import cors from 'cors';
import express from 'express';
import type { HealthResponse } from '@bme/shared';
import { prisma } from './lib/prisma';

const app = express();
app.use(cors({ origin: process.env.WEB_ORIGIN, credentials: true }));
app.use(express.json());

app.get('/api/v1/health', async (_req, res) => {
  let database: HealthResponse['database'] = 'up';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'down';
  }
  const body: HealthResponse = { status: 'ok', database, serverTime: new Date().toISOString() };
  res.status(database === 'up' ? 200 : 503).json(body);
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
