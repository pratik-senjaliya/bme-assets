# Implementation plan

Condensed from the claude.ai doc "Biomedical Asset Management System — Implementation Plan" (2026-10-07). Estimates assume one full-time developer (~9 weeks). Each phase ends deployed and clickable.

## Phase 0 — Setup (~2 days)

- [x] Monorepo with npm workspaces: apps/web, apps/api, packages/shared
- [x] docker-compose.dev.yml with Postgres 16
- [x] Prisma connected; health route `GET /api/v1/health` queries the DB; web home page shows it
- [x] First `npm install` and run; `package-lock.json` committed
- [ ] Create Supabase project (database + private storage bucket) for Phase 3

## Phase 1 — Foundation (~1.5 weeks)

Goal: four seeded users log in; each sees only what the role allows; every change is audited.

- [x] Full Prisma schema (all tables in docs/architecture.md) in one migration
- [x] Seed: settings, 3 departments + locations, 4 equipment types, 4 roles + default permissions, 1 user per role, ~10 assets
- [x] Auth: bcrypt login, JWT httpOnly cookie, /auth/me with permission codes, logout
- [x] `requirePermission()` middleware + department scope helper for nursing
- [x] Audit middleware (actor, action, entity, before/after, IP)
- [x] Error handler + zod validation middleware
- [x] Settings API (asset ID pattern super-admin only, locked after first asset), CRUD departments/locations/equipment types/users
- [x] Web: Ant Design theme, app shell with permission-based menu, login, admin screens, shared API client, table wrapper
- Check: nursing gets 403 on admin routes called directly

## Phase 2 — Asset register (~1.5 weeks)

- [x] Asset ID generator with locked counter; test 20 parallel creates → 20 unique IDs
- [x] Assets API (filters, paging), calculated age and warranty status
- [x] Purchase orders, service contracts
- [x] Storage adapter (local, supabase) + attachments (PDF/JPG/PNG, 10 MB)
- [x] Timeline endpoint
- [x] Excel import: template, validation, all-or-nothing, error report
- [x] Web: asset list, add/edit form, detail page with tabs, upload widget, import wizard
- Check: 50-row import with 3 bad rows inserts nothing and reports the 3 rows

## Phase 3 — Complaints, expenses, first demo (~1 week)

- [x] Complaints API (department-limited create, start, resolve), server timestamps, sequence numbers
- [x] Response time and downtime with tests
- [x] Service expenses API
- [x] Web: nursing equipment list + complaint form; biomedical complaint board; asset complaint/expense tabs
- [ ] Deploy: migrate Supabase, Render (API), Vercel (web, API_URL rewrite), demo logins + click path
- Check: full complaint round trip on the live link

## Phase 4 — PMS, calibration, reminders (~2 weeks)

- [x] Versioned PMS template schema (JSONB) + builder
- [x] PMS records server-dated, read-only after submit, next due updated; correction = linked new record
- [x] Calibration records, due lists
- [x] pg-boss daily job 06:00 hospital time → notifications at 30/15/5 days, no duplicates
- [x] Optional SMTP email
- [x] Web: template builder, PMS form + print view, calibration, due-this-month page, notification bell
- Check: forged date in request is ignored; faked clock creates one reminder per threshold

## Phase 5 — Approvals, condemnation, reports, packaging (~2 weeks)

- [ ] Approval requests applied transactionally with audit entry
- [ ] Condemnation flow with EOL letters
- [ ] Dashboard + all Excel reports + audit log viewer
- [ ] Dockerfiles, docker-compose.yml (postgres, api, web, proxy), nightly backups (14 days)
- [ ] Install and upgrade guides
- Check: fresh Linux VM to working login in under 30 minutes

## Open decisions

| Decision | Needed by | Default |
|---|---|---|
| How a submitted PMS report is corrected | Phase 4 | New linked record, original read-only |
| First equipment types with PMS templates | Phase 4 | Ventilator, patient monitor, defibrillator, infusion pump |
| Which equipment counts as critical | Phase 5 | Criticality field set per asset by HOD |
| Hospital server OS | Phase 5 | Linux + Docker |
| Sample PMS/calibration report formats | Phase 4 | Generic template |
