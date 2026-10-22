-- Gap review, batch 2: notices that open their complaint, the last email result, the bell for the wards, and approvals
-- that keep what they were about after the record is gone.

-- AlterTable
ALTER TABLE "hospital_settings" ADD COLUMN     "mailLastError" TEXT,
ADD COLUMN     "mailLastErrorAt" TIMESTAMP(3),
ADD COLUMN     "mailLastSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "complaintId" TEXT;


-- The wards hear what happens to their complaints: nursing gets the bell (a hospital can still take it away in Roles).
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."name" = 'nursing' AND p."code" = 'notification.view'
ON CONFLICT DO NOTHING;

-- Approved deletions keep what was deleted: from now on a copy is taken when the HOD decides; for the ones already
-- decided it comes from the audit log's copy of the deleted record.
UPDATE "approval_requests" r
SET "payload" = r."payload" || jsonb_build_object('snapshot', jsonb_build_object(
  'assetCode', COALESCE(a."before"->>'assetCode', owner."assetCode"),
  'assetName', COALESCE(CASE WHEN r."targetType" = 'asset' THEN a."before"->>'name' END, owner."name"),
  'summary', CASE r."targetType"
    WHEN 'asset' THEN 'Delete this asset (entered by mistake). Its ID is not reused.'
    WHEN 'purchase_order' THEN 'Delete purchase order ' || COALESCE(a."before"->>'poNumber', '') || ' (' || COALESCE(a."before"->>'vendor', '') || ')'
    WHEN 'service_contract' THEN 'Delete ' || upper(replace(COALESCE(a."before"->>'type', ''), '_', '-')) || ' contract with ' || COALESCE(a."before"->>'vendor', '')
    WHEN 'service_expense' THEN 'Delete expense "' || COALESCE(a."before"->>'description', '') || '"'
    WHEN 'service_log' THEN 'Delete service entry "' || left(COALESCE(a."before"->>'description', ''), 60) || '"'
    WHEN 'complaint' THEN 'Delete complaint ' || COALESCE(a."before"->>'complaintNo', '') || ' "' || left(COALESCE(a."before"->>'description', ''), 60) || '" (raised by mistake)'
  END))
FROM "audit_logs" a
LEFT JOIN "assets" owner ON owner."id" = a."before"->>'assetId'
WHERE r."type" = 'delete' AND r."status" = 'approved' AND NOT (r."payload" ? 'snapshot')
  AND a."entityId" = r."targetId" AND a."action" = r."targetType" || '.delete';
