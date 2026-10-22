-- Gap review, batch 1 (safety): urgent complaints, failed PMS / calibration flags on the machine, the biomedical
-- on-call contact and sign-out of idle shared PCs.

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "calibrationFailedOn" DATE,
ADD COLUMN     "pmsFailedOn" DATE;

-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "urgent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "hospital_settings" ADD COLUMN     "biomedContact" TEXT,
ADD COLUMN     "idleLogoutMinutes" INTEGER NOT NULL DEFAULT 30;


-- Machines whose latest PMS failed start flagged. A corrected record counts as its correction.
UPDATE "assets" a SET "pmsFailedOn" = last."performedOn"
FROM (
  SELECT DISTINCT ON (r."assetId") r."assetId", r."performedOn", r."result"
  FROM "pms_records" r
  WHERE NOT EXISTS (SELECT 1 FROM "pms_records" c WHERE c."correctsRecordId" = r."id")
  ORDER BY r."assetId", r."performedOn" DESC, r."submittedAt" DESC
) last
WHERE last."assetId" = a."id" AND last."result" = 'fail';

-- Likewise for the latest calibration.
UPDATE "assets" a SET "calibrationFailedOn" = last."doneOn"
FROM (
  SELECT DISTINCT ON (r."assetId") r."assetId", r."doneOn", r."result"
  FROM "calibration_records" r
  ORDER BY r."assetId", r."doneOn" DESC, r."createdAt" DESC
) last
WHERE last."assetId" = a."id" AND last."result" = 'fail';
