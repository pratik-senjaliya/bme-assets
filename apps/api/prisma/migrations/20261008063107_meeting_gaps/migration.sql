-- CreateEnum
CREATE TYPE "ServiceKind" AS ENUM ('amc_visit', 'cmc_visit', 'repair', 'inspection', 'other');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttachmentKind" ADD VALUE 'contract';
ALTER TYPE "AttachmentKind" ADD VALUE 'service_report';
ALTER TYPE "AttachmentKind" ADD VALUE 'invoice';
ALTER TYPE "AttachmentKind" ADD VALUE 'condemnation_form';
ALTER TYPE "AttachmentKind" ADD VALUE 'other';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "openingCalibrationOn" DATE,
ADD COLUMN     "openingPmsOn" DATE;

-- AlterTable
ALTER TABLE "hospital_settings" ADD COLUMN     "criticalDowntimeHours" INTEGER NOT NULL DEFAULT 24;

-- CreateTable
CREATE TABLE "service_logs" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "kind" "ServiceKind" NOT NULL,
    "vendor" TEXT,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "service_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_logs_assetId_idx" ON "service_logs"("assetId");

-- AddForeignKey
ALTER TABLE "service_logs" ADD CONSTRAINT "service_logs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
