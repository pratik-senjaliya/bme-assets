# Architecture

Condensed from the claude.ai doc "Biomedical Asset Management System — System Design" (2026-10-07).

## Overview

```
Browser (hospital LAN PCs)
   │  same origin
   ▼
Next.js web ── proxy /api/v1/* (API_URL) ──▶ Express API ──▶ PostgreSQL (Prisma)
                                       │  owns auth,  ──▶ File storage (local disk | Supabase Storage)
                                       │  rules, audit ──▶ SMTP (optional)
                                       └─ daily reminder job (pg-boss)
```

The browser never reaches the database. Date locks, approvals and department filters cannot be bypassed from the client.

| Environment | Web | API | Database | Files |
|---|---|---|---|---|
| Local dev | `next dev` | `tsx watch` | Postgres in Docker | `./uploads` |
| Demo | Vercel | Render | Supabase Postgres | Supabase Storage |
| On-prem | Docker | Docker | Postgres container | server disk |

Switching environment changes env vars only, never code.

## Modules (v1)

1. **Asset register** — generated asset ID, name, type, make, model, serial, department, location, criticality, status; photos, manuals; age calculated from installation date.
2. **Lifecycle timeline** — PO → installation (date, report, photos) → warranty (expiry calculated) → CMC / AMC / in-house PM contracts.
3. **PMS** — frequency per asset, report template per equipment type (JSONB), server-dated, read-only once submitted, next due calculated.
4. **Calibration** — done date, due date, agency, certificate, history.
5. **Complaints** — auto-numbered; nursing raises, biomedical starts and resolves; response time and downtime.
6. **Service expenses** — repair and spare-part costs per asset / complaint.
7. **Condemnation** — request + EOL letters, HOD approves, asset archived but kept in history.
8. **Approvals** — HOD queue for condemn, delete, key-field edits.
9. **Reminders** — daily job, 30/15/5-day in-app alerts, optional email.
10. **Dashboard and reports** — read on screen with charts, exported to Excel or PDF: asset master, PMS, calibration, breakdowns (monthly/yearly), uptime, downtime of critical equipment, equipment age, expenses.
11. **Settings, import, audit** — departments, locations, equipment types, PMS templates, reminder days, SMTP, bulk Excel import, audit log.

## Data model (PostgreSQL, Prisma)

Every table has `id`, `created_at`, `updated_at`, `created_by`.

| Area | Table | Key fields |
|---|---|---|
| Setup | hospital_settings | name, short_code, asset_id_pattern, pattern_locked, reminder_days, smtp config |
| Setup | departments | name, code |
| Setup | locations | department_id, name |
| Setup | equipment_types | name, code, default_pms_months, default_calibration_months, pms_template_id |
| Access | users | name, email, password_hash, role_id, department_id (nursing), active |
| Access | roles | name (super_admin, admin, biomed, nursing), is_system |
| Access | permissions | code (asset.create, asset.edit_key, complaint.resolve, …) |
| Access | role_permissions | role_id, permission_id |
| Assets | assets | asset_code (unique), sequence_no, equipment_type_id, name, make, model, serial_no, department_id, location_id, criticality, status (active, not_in_use, condemned), installation_date, warranty_months, warranty_end, pms_frequency_months, next_pms_due, next_calibration_due |
| Assets | purchase_orders | asset_id, po_number, po_date, vendor, cost |
| Assets | service_contracts | asset_id, type (warranty, cmc, amc, in_house), vendor, start_date, end_date, cost |
| Assets | attachments | owner_type, owner_id, kind (po, installation_report, photo, manual, certificate, eol_letter), file_path, mime, size |
| PMS | pms_templates | equipment_type_id, version, schema (JSONB) |
| PMS | pms_records | asset_id, template_id + version, performed_on (server date), performed_by, answers (JSONB), result, submitted_at, locked, corrects_record_id |
| Calibration | calibration_records | asset_id, done_on, due_on, agency, result, certificate attachment |
| Complaints | complaints | complaint_no, asset_id, raised_by, department_id, description, status, raised_at, started_at, started_by, resolved_at, resolved_by, resolution_notes |
| Expenses | service_expenses | asset_id, complaint_id?, type (repair, spare_part), description, amount, date, vendor |
| Workflow | approval_requests | type (condemn, delete, edit_key_field), target_type, target_id, payload (JSONB), requested_by, status, decided_by, decided_at, reason |
| Workflow | notifications | user_id or role, type, asset_id, due_date, threshold_days, message, read_at, emailed_at |
| Audit | audit_logs | actor_id, action, entity_type, entity_id, before (JSONB), after (JSONB), ip, at — insert-only |

Uptime, downtime, breakdown counts and equipment age are computed by queries, not stored.

## API outline (`/api/v1`, JSON, JWT httpOnly cookie)

| Resource | Endpoints |
|---|---|
| Auth | POST /auth/login, POST /auth/logout, GET /auth/me |
| Users, roles | CRUD /users, GET/PUT /roles/:id/permissions |
| Setup | /departments, /locations, /equipment-types, /pms-templates, GET/PUT /settings |
| Assets | GET /assets, POST /assets, GET/PATCH /assets/:id, GET /assets/:id/timeline |
| Asset records | /assets/:id/purchase-orders, /contracts, /attachments, /expenses |
| PMS | GET /pms/due, POST /assets/:id/pms, GET /pms/:id |
| Calibration | GET /calibration/due, POST /assets/:id/calibrations |
| Complaints | GET/POST /complaints, POST /complaints/:id/start, POST /complaints/:id/resolve |
| Approvals | GET /approvals, POST /approvals/:id/approve, POST /approvals/:id/reject |
| Notifications | GET /notifications, POST /notifications/:id/read |
| Reports | GET /dashboard, GET /reports/:type?from&to&group&format=json\|xlsx\|pdf, GET /assets/:id/history?format=json\|xlsx\|pdf |
| Import | POST /import/assets, GET /import/template |
| Audit | GET /audit-logs |
| Health | GET /health |

## Out of scope for v1

Barcode/RFID scanning, sticker printing, AI-assisted complaint resolution, mobile app, multi-hospital installs.
