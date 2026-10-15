-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedBy" TEXT,
ADD COLUMN     "assignedToId" TEXT;

-- CreateIndex
CREATE INDEX "complaints_assignedToId_idx" ON "complaints"("assignedToId");

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Complaints already being worked on (or fixed) belong to whoever started them.
UPDATE "complaints" SET "assignedToId" = "startedBy", "assignedAt" = "startedAt", "assignedBy" = "startedBy" WHERE "startedBy" IS NOT NULL;
