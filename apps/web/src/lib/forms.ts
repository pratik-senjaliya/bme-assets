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
    result.error.issues.map((i) => ({ name: i.path as (string | number)[], errors: [friendly(i)] })),
  );
  // Take the person to the first problem on a long form.
  const first = result.error.issues[0]?.path;
  if (first?.length) form.scrollToField(first as (string | number)[], { behavior: 'smooth', block: 'center' });
  return null;
}

// zod's built-in messages ("Required", "String must contain at least 1 character(s)") read like a program talking.
// Messages written in the schemas ("Enter the PO number") are kept; only the defaults are put into plain words.
function friendly(i: z.ZodIssue): string {
  const choice = /Id$/.test(String(i.path[i.path.length - 1] ?? ''));
  switch (i.code) {
    case 'invalid_type':
      return i.received === 'undefined' || i.received === 'null' ? (choice ? 'Please choose one' : 'Please fill this in') : i.message === 'Required' ? 'Please fill this in' : 'Please check this value';
    case 'too_small':
      if (i.message !== defaultSmall(i)) return i.message;
      if (i.type === 'string') return Number(i.minimum) <= 1 ? 'Please fill this in' : `Use at least ${i.minimum} characters`;
      if (i.type === 'number') return `Must be ${i.inclusive ? 'at least' : 'more than'} ${i.minimum}`;
      if (i.type === 'array') return Number(i.minimum) <= 1 ? 'Choose at least one' : `Choose at least ${i.minimum}`;
      return i.message;
    case 'too_big':
      if (!/^(String|Number|Array) must/.test(i.message)) return i.message;
      if (i.type === 'string') return `Keep it under ${Number(i.maximum) + 1} characters`;
      if (i.type === 'number') return `Must be ${i.inclusive ? 'at most' : 'less than'} ${i.maximum}`;
      return `Choose at most ${i.maximum}`;
    case 'invalid_string':
      if (i.validation === 'email' && i.message === 'Invalid email') return 'Enter a valid email, like name@hospital.in';
      if (i.validation === 'uuid' && i.message === 'Invalid uuid') return 'Please choose one';
      return i.message;
    case 'invalid_enum_value':
      return 'Please choose one of the options';
    default:
      return i.message;
  }
}
const defaultSmall = (i: z.ZodTooSmallIssue) =>
  i.type === 'string'
    ? `String must contain ${i.exact ? 'exactly' : 'at least'} ${i.minimum} character(s)`
    : i.type === 'number'
      ? `Number must be ${i.inclusive ? 'greater than or equal to' : 'greater than'} ${i.minimum}`
      : i.type === 'array'
        ? `Array must contain ${i.exact ? 'exactly' : 'at least'} ${i.minimum} element(s)`
        : i.message;

// Shows API field errors (400 from the server) on the form; returns true if it handled the error.
export function showApiFieldErrors(form: FormInstance, e: unknown): boolean {
  if (!(e instanceof ApiError) || !e.details?.fieldErrors) return false;
  const entries = Object.entries(e.details.fieldErrors).filter(([, v]) => v?.length);
  if (!entries.length) return false;
  // The server uses the same schemas, so its default messages get the same plain wording.
  form.setFields(entries.map(([name, errors]) => ({ name, errors: (errors as string[]).map(plain) })));
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

const plain = (m: string) =>
  m === 'Required' || /^String must contain at least 1 character/.test(m) ? 'Please fill this in' : m === 'Invalid email' ? 'Enter a valid email, like name@hospital.in' : m === 'Invalid uuid' ? 'Please choose one' : m;
