-- PMS done by the OEM engineer (decision A): its kind, who did it, and no checklist needed. Adding columns and
-- dropping NOT NULL change no rows, so the trigger that keeps PMS records read-only is not involved.
ALTER TABLE "pms_records" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'in_house';
ALTER TABLE "pms_records" ADD COLUMN "serviceBy" TEXT;
ALTER TABLE "pms_records" ALTER COLUMN "templateId" DROP NOT NULL;
