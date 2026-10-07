import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { message: 'Not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { message: 'Validation failed', details: err.flatten() } });
    return;
  }
  if (err instanceof MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: { message: tooBig ? 'That file is too large' : 'Upload failed' } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { message: 'That value already exists' } });
      return;
    }
    if (err.code === 'P2003') {
      res.status(409).json({ error: { message: 'In use by other records, so it cannot be changed or removed' } });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { message: 'Not found' } });
      return;
    }
  }
  // Malformed JSON body etc.
  if (typeof (err as { status?: unknown }).status === 'number' && (err as { status: number }).status < 500) {
    res.status((err as { status: number }).status).json({ error: { message: 'Bad request' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { message: 'Something went wrong' } });
};
