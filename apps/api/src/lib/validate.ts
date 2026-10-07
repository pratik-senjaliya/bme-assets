import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { HttpError } from './errors';

// Validates req.body with a schema from @bme/shared and replaces it with the parsed value.
export const validate =
  (schema: z.ZodTypeAny): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) throw new HttpError(400, 'Validation failed', result.error.flatten());
    req.body = result.data;
    next();
  };

// Route param `:id` as a plain string (Express types allow string[]).
export const idOf = (req: Request) => String(req.params.id);
