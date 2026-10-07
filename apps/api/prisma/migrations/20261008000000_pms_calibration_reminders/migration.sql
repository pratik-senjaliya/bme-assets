-- AlterTable
ALTER TABLE "pms_records" ADD COLUMN     "correctionReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notification_dedupe" ON "notifications"("userId", "type", "assetId", "dueDate", "thresholdDays");


-- A submitted PMS record is read-only: no UPDATE and no DELETE, enforced by the database itself so no
-- code path (including future ones) can rewrite history. Corrections are new rows linked by
-- "correctsRecordId". The one escape hatch is a session that sets bme.allow_pms_cleanup = on, which
-- the application never does; the automated tests use it to remove their own test data.
CREATE OR REPLACE FUNCTION pms_records_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('bme.allow_pms_cleanup', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pms_records are read-only once submitted (record %)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pms_records_immutable
  BEFORE UPDATE OR DELETE ON "pms_records"
  FOR EACH ROW EXECUTE FUNCTION pms_records_immutable();
