-- Gap review batch 3: calibration corrections, sign-in names, first-sign-in password change, backup status.
-- AlterTable
ALTER TABLE "calibration_records" ADD COLUMN     "correctionReason" TEXT,
ADD COLUMN     "correctsRecordId" TEXT;

-- AlterTable
ALTER TABLE "hospital_settings" ADD COLUMN     "backupLastAt" TIMESTAMP(3),
ADD COLUMN     "backupLastError" TEXT,
ADD COLUMN     "backupLastErrorAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "username" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "calibration_records_correctsRecordId_key" ON "calibration_records"("correctsRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "calibration_records" ADD CONSTRAINT "calibration_records_correctsRecordId_fkey" FOREIGN KEY ("correctsRecordId") REFERENCES "calibration_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

