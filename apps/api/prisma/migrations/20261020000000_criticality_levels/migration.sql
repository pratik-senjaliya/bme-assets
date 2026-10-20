-- The hospital's own criticality levels. Renamed in place from the highest down so no two values clash;
-- each asset keeps its level (critical -> Most critical, high -> Critical, medium -> Minor, low -> General).
ALTER TYPE "Criticality" RENAME VALUE 'critical' TO 'most_critical';
ALTER TYPE "Criticality" RENAME VALUE 'high' TO 'critical';
ALTER TYPE "Criticality" RENAME VALUE 'medium' TO 'minor';
ALTER TYPE "Criticality" RENAME VALUE 'low' TO 'general';
ALTER TABLE "assets" ALTER COLUMN "criticality" SET DEFAULT 'minor';
