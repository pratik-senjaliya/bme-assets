-- Suppliers directory with contacts, and each asset's supplier and service vendor.
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);
-- One company per name, whatever the capitals.
CREATE UNIQUE INDEX "vendors_name_lower_key" ON "vendors"(lower("name"));

CREATE TABLE "vendor_contacts" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_contacts_vendorId_idx" ON "vendor_contacts"("vendorId");
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assets" ADD COLUMN "supplierId" TEXT, ADD COLUMN "serviceVendorId" TEXT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_serviceVendorId_fkey" FOREIGN KEY ("serviceVendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
