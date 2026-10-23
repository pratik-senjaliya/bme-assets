-- Facility add-on F2: ward complaints without a machine (a trade and a location), and who looks after medical gases.
ALTER TABLE "hospital_settings" ADD COLUMN "medicalGasRegister" "Register" NOT NULL DEFAULT 'biomedical',
  ADD COLUMN "facilityContact" TEXT;
ALTER TABLE "equipment_types" ADD COLUMN "medicalGas" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "register" "Register" NOT NULL DEFAULT 'facility',
    "medicalGas" BOOLEAN NOT NULL DEFAULT false,
    "responseHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trades_name_key" ON "trades"("name");

ALTER TABLE "complaints" ALTER COLUMN "assetId" DROP NOT NULL,
  ADD COLUMN "tradeId" TEXT,
  ADD COLUMN "locationId" TEXT;
CREATE INDEX "complaints_tradeId_idx" ON "complaints"("tradeId");
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A complaint is about a machine, or about a trade at a location.
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_machine_or_trade" CHECK ("assetId" IS NOT NULL OR ("tradeId" IS NOT NULL AND "locationId" IS NOT NULL));
