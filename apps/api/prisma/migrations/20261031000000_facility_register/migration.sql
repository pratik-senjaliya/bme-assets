-- Facility maintenance add-on, F1 (docs/requirements-facility.md): every equipment type, machine, complaint and
-- consumable belongs to a register (team). Everything that exists today is biomedical.
CREATE TYPE "Register" AS ENUM ('biomedical', 'facility');

ALTER TABLE "hospital_settings" ADD COLUMN "facilityEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "equipment_types" ADD COLUMN "register" "Register" NOT NULL DEFAULT 'biomedical';
ALTER TABLE "assets" ADD COLUMN "register" "Register" NOT NULL DEFAULT 'biomedical';
ALTER TABLE "complaints" ADD COLUMN "register" "Register" NOT NULL DEFAULT 'biomedical';
ALTER TABLE "consumable_items" ADD COLUMN "register" "Register" NOT NULL DEFAULT 'biomedical';

CREATE INDEX "assets_register_idx" ON "assets"("register");
CREATE INDEX "complaints_register_idx" ON "complaints"("register");
