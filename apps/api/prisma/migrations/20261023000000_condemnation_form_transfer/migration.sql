-- Equipment transferred to another unit (with HOD approval), and the switch that turns transfers on.
-- The condemnation committee's details live in the request's payload, so they need no columns.
ALTER TYPE "AssetStatus" ADD VALUE 'transferred';
ALTER TYPE "ApprovalType" ADD VALUE 'transfer';
ALTER TABLE "hospital_settings" ADD COLUMN "transfersEnabled" BOOLEAN NOT NULL DEFAULT false;
