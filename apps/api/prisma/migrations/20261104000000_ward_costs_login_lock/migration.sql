-- Costs on ward complaints without a machine (an expense has a machine or a complaint), and the sign-in lock in the database.
-- AlterTable
ALTER TABLE "service_expenses" ALTER COLUMN "assetId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "login_attempts" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("key")
);


-- An expense is booked on a machine, or on a complaint (a ward fault without one).
ALTER TABLE "service_expenses" ADD CONSTRAINT "service_expenses_asset_or_complaint" CHECK ("assetId" IS NOT NULL OR "complaintId" IS NOT NULL);
