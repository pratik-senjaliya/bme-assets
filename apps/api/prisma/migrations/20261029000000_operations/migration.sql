-- Gap review batch 4a: deputy HOD, the fixed address on QR labels, the daily job's last run.
-- AlterTable
ALTER TABLE "hospital_settings" ADD COLUMN     "dailyJobLastRunAt" TIMESTAMP(3),
ADD COLUMN     "labelBaseUrl" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deputy" BOOLEAN NOT NULL DEFAULT false;

