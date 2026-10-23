-- Facility add-on F3: statutory licences and inspections, and licence reminders in the bell.
-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "licenceId" TEXT;

-- CreateTable
CREATE TABLE "licences" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "number" TEXT,
    "validFrom" DATE,
    "validTo" DATE NOT NULL,
    "assetId" TEXT,
    "register" "Register" NOT NULL DEFAULT 'facility',
    "notes" TEXT,
    "renewsId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "licences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "licences_renewsId_key" ON "licences"("renewsId");

-- CreateIndex
CREATE INDEX "licences_validTo_idx" ON "licences"("validTo");

-- AddForeignKey
ALTER TABLE "licences" ADD CONSTRAINT "licences_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licences" ADD CONSTRAINT "licences_renewsId_fkey" FOREIGN KEY ("renewsId") REFERENCES "licences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

