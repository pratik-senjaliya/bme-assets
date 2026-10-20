-- Complaint workflow: escalate to the HOD, on hold (HOD only), and closing by whoever raised it.
ALTER TYPE "ComplaintStatus" ADD VALUE 'on_hold' BEFORE 'resolved';
ALTER TYPE "ComplaintStatus" ADD VALUE 'closed';

ALTER TABLE "complaints"
  ADD COLUMN "escalatedAt" TIMESTAMP(3),
  ADD COLUMN "escalatedBy" TEXT,
  ADD COLUMN "holdNote" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "closedBy" TEXT,
  ADD COLUMN "closeNote" TEXT;

ALTER TABLE "hospital_settings" ADD COLUMN "complaintCloseDays" INTEGER NOT NULL DEFAULT 3;

CREATE TABLE "complaint_steps" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT,
    CONSTRAINT "complaint_steps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "complaint_steps_complaintId_idx" ON "complaint_steps"("complaintId");
ALTER TABLE "complaint_steps" ADD CONSTRAINT "complaint_steps_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "complaints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
