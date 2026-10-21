-- Consumables (step 6 of docs/requirements-2026-10-20.md): items kept in stock and every movement in or out.

-- CreateEnum
CREATE TYPE "ConsumableKind" AS ENUM ('in', 'out', 'adjust');

-- CreateTable
CREATE TABLE "consumable_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,2),
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "consumable_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumable_movements" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" "ConsumableKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "unitCost" DECIMAL(12,2),
    "supplierId" TEXT,
    "reference" TEXT,
    "departmentId" TEXT,
    "assetId" TEXT,
    "complaintId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "consumable_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consumable_movements_itemId_createdAt_idx" ON "consumable_movements"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "consumable_movements_date_idx" ON "consumable_movements"("date");

-- CreateIndex
CREATE INDEX "consumable_movements_assetId_idx" ON "consumable_movements"("assetId");

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "consumable_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Item names are unique whatever the capitals; stock never goes below zero, whatever the code does.
CREATE UNIQUE INDEX "consumable_items_name_lower_key" ON "consumable_items" (lower("name"));
ALTER TABLE "consumable_items" ADD CONSTRAINT "consumable_items_stock_check" CHECK ("stock" >= 0);
