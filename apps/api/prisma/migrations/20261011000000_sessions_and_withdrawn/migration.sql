-- A requester can take back their own pending approval request.
ALTER TYPE "ApprovalStatus" ADD VALUE 'withdrawn';

-- Raised when a password changes, so sessions signed before it stop working.
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
