import type { FormInstance } from 'antd';
import { useCallback, useRef } from 'react';
import type { z } from 'zod';
import { ApiError } from './api';

// Validates form values with the same zod schema the API uses, then maps problems onto the fields.
// Returns the parsed (trimmed / normalised) values, or null when something is invalid.
export function parseForm<S extends z.ZodTypeAny>(form: FormInstance, schema: S, values: unknown): z.infer<S> | null {
  const result = schema.safeParse(values);
  if (result.success) return result.data;
  form.setFields(
    result.error.issues.map((i) => ({ name: i.path as (string | number)[], errors: [i.message] })),
  );
  return null;
}

// Shows API field errors (400 from the server) on the form; returns true if it handled the error.
export function showApiFieldErrors(form: FormInstance, e: unknown): boolean {
  if (!(e instanceof ApiError) || !e.details?.fieldErrors) return false;
  const entries = Object.entries(e.details.fieldErrors).filter(([, v]) => v?.length);
  if (!entries.length) return false;
  form.setFields(entries.map(([name, errors]) => ({ name, errors: errors as string[] })));
  return true;
}

// Saving must happen once. React state ("saving") only updates after the next draw, so a fast double click or a key
// held down can start a second save first. This remembers in a ref, which changes at once, that one is running.
export function useSingleFlight() {
  const running = useRef(false);
  return useCallback(async (job: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    try {
      await job();
    } finally {
      running.current = false;
    }
  }, []);
}
