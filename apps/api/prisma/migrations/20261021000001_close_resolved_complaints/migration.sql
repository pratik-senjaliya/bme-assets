-- Complaints resolved before closing existed are taken as closed when they were resolved, so nobody is asked to
-- close old complaints. (A separate migration: a new enum value cannot be used in the transaction that adds it.)
UPDATE "complaints" SET "status" = 'closed', "closedAt" = "resolvedAt" WHERE "status" = 'resolved';
