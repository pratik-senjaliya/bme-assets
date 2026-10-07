// Types and (later) zod schemas shared by apps/api and apps/web.
// Rule: every request body schema lives here so the API and the forms validate the same way.

export type HealthResponse = {
  status: 'ok';
  database: 'up' | 'down';
  serverTime: string;
};
