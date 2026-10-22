-- Gap review batch 4b: the hospital's own tag number and a per-machine calibration interval.
-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "calibrationFrequencyMonths" INTEGER,
ADD COLUMN     "tagNo" TEXT;

