-- Facility add-on F4: the plant-room logbook (reading types and server-dated, read-only readings) and PMS by run hours.
-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "lastPmsHours" DOUBLE PRECISION,
ADD COLUMN     "pmsEveryHours" INTEGER;

-- CreateTable
CREATE TABLE "reading_types" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'level',
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "every" TEXT NOT NULL DEFAULT 'day',
    "runHours" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "reading_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readings" (
    "id" TEXT NOT NULL,
    "readingTypeId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenBy" TEXT NOT NULL,
    "note" TEXT,
    "outOfRange" BOOLEAN NOT NULL DEFAULT false,
    "correctsId" TEXT,
    "correctionReason" TEXT,

    CONSTRAINT "readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reading_types_assetId_name_key" ON "reading_types"("assetId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "readings_correctsId_key" ON "readings"("correctsId");

-- CreateIndex
CREATE INDEX "readings_readingTypeId_takenAt_idx" ON "readings"("readingTypeId", "takenAt");

-- CreateIndex
CREATE INDEX "readings_assetId_takenAt_idx" ON "readings"("assetId", "takenAt");

-- AddForeignKey
ALTER TABLE "reading_types" ADD CONSTRAINT "reading_types_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readings" ADD CONSTRAINT "readings_readingTypeId_fkey" FOREIGN KEY ("readingTypeId") REFERENCES "reading_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readings" ADD CONSTRAINT "readings_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readings" ADD CONSTRAINT "readings_correctsId_fkey" FOREIGN KEY ("correctsId") REFERENCES "readings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A reading is read-only once taken, like a PMS record: corrections are new rows linked by "correctsId". The tests'
-- cleanup uses the same escape hatch as PMS records (bme.allow_pms_cleanup), which the application never sets.
CREATE OR REPLACE FUNCTION readings_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('bme.allow_pms_cleanup', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'readings are read-only once taken (reading %)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER readings_immutable
  BEFORE UPDATE OR DELETE ON "readings"
  FOR EACH ROW EXECUTE FUNCTION readings_immutable();
