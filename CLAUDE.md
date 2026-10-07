# CLAUDE.md — BME Asset Management

Context for Claude Code sessions. Read this first, then `docs/architecture.md` and `docs/implementation-plan.md`.

## What this is

A web app for a hospital's **biomedical engineering (BME) department** to track every piece of medical equipment from purchase order to condemnation: asset register, lifecycle history, PMS (preventive maintenance), calibration, complaints/breakdowns, service expenses, HOD approvals, reminders, dashboard and Excel reports.

- **Sold product:** installed **on-premise** on each hospital's own server, used over the hospital LAN. One install = one hospital (no multi-tenancy).
- **Demo (now):** cloud-hosted for stakeholders. Vercel (web) + Render (API) + Supabase used **only as hosted Postgres and file storage**. No Supabase Auth, RLS or edge functions — all logic lives in our Express API so the same code runs on-prem.
- **Web app only.** No mobile app, by decision: complaints must come from department logins, not anyone's phone.
- Users are in India: timezone `Asia/Kolkata`, dates `07 Oct 2026`, money `₹` with `en-IN` grouping.

## Roles (defaults; permissions are stored in DB and adjustable per hospital)

| Role | Can do |
|---|---|
| Super admin (vendor) | Install setup, hospital profile, asset ID pattern, first admin, support. Cannot be deleted by the hospital. Audited like everyone; cannot back-date PMS or bypass approvals. |
| Admin (Biomedical HOD) | Users, permissions, settings, PMS templates; approves condemnation, deletions and key-field edits; full access. |
| Biomedical staff | Assets, PMS, calibration, start/resolve complaints, expenses; *requests* condemn/delete/key edits. |
| Nursing staff | Tied to one department: read-only view of that department's equipment + raise complaints. Nothing else. |

## Non-negotiable business rules (enforce on the server, never trust the browser)

1. **PMS date lock:** the server stamps `performed_on` = today in `APP_TIMEZONE`; any client date is ignored. No back-dating, no future dating. Submitted PMS records are read-only. Corrections = a new record linked to the original (pending stakeholder confirmation).
2. **Asset ID:** generated from an install-time pattern, e.g. `{HOSP}-{DEPT}-{TYPE}-{LOC}-{SEQ:3}` → `SHL-BME-VENT-ICU1-001`. Sequence from a DB counter inside the create transaction. Pattern locks once the first asset exists. IDs are never reused (condemned assets keep theirs).
3. **HOD approval** required for: condemnation, deleting a wrong entry, editing key fields (serial no., location, asset ID details). Change is stored as a proposal and applied only on approval.
4. **Department scoping:** nursing users only ever see/act on their own department's assets — filter in every query.
5. **Audit log:** every create/update/delete/approval/login → append-only `audit_logs` (actor, action, entity, before/after JSON, IP, time).
6. **Complaint metrics:** status Open → In progress → Resolved only; server timestamps. Response time = started − raised. Downtime = resolved − raised.
7. **Condemned / not-in-use assets** leave active lists, reminders and due lists but stay in history and Excel exports (labelled).
8. **Reminders:** daily job, in-app notifications at configurable lead days (default 30/15/5) for PMS, calibration, warranty, contracts. Email only if SMTP is configured (hospital servers may have no internet).

## Stack

- `apps/web` — Next.js 15 (App Router) + TypeScript; Ant Design from Phase 1. Browser calls `/api/v1/*` on its own origin; `next.config.ts` rewrites to the API (`API_URL`).
- `apps/api` — Node + Express 5 + TypeScript + Prisma + PostgreSQL. zod validation, JWT in httpOnly cookie, bcrypt, pg-boss for jobs, ExcelJS for import/export, Nodemailer (optional).
- `packages/shared` — types and zod schemas used by both apps (build it before running apps; root scripts do this).
- Files: storage adapter with `local` (on-prem disk) and `supabase` drivers, chosen by `STORAGE_DRIVER`.
- On-prem (Phase 5): Docker Compose (postgres, api, web, reverse proxy) + nightly `pg_dump` and uploads backup.

## Commands

```bash
npm install                 # from repo root (workspaces)
npm run db:up               # local Postgres 16 in Docker (docker-compose.dev.yml)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run dev:api             # http://localhost:4000/api/v1/health
npm run dev:web             # http://localhost:3000 shows API + DB status
npm run typecheck
npm run prisma:migrate -w apps/api -- --name <name>   # after schema changes
```

## Conventions

- TypeScript strict everywhere. Keep it simple: no abstractions with one implementation, reuse helpers before writing new ones (see the `ponytail` skill if available).
- One zod schema per request body in `packages/shared`; API validates with it, forms reuse it.
- API routes under `/api/v1`, grouped by module in `apps/api/src/modules/<module>/` (routes + service). Every route checks a permission code.
- Prisma migrations are committed with the code that needs them.
- Tests: one integration test per legally important rule (PMS date lock, asset ID sequence, approval gate, department filter, downtime calc). No coverage targets otherwise.
- UI: follow the `bme-ui-design` skill if available — calm Ant Design theme, one status-colour mapping, standard list/detail/form patterns.
- Branch per task, PR into `main`; `main` stays deployable.

## Status

- [x] Phase 0 scaffold; verified (health shows Database: up)
- [x] Phase 1 Foundation built: full schema + migration, seed, auth, permissions, audit, settings/setup/users/roles APIs, web shell + admin screens. `npm test -w apps/api` needs a seeded DB.
- [x] Phase 2 Asset register built: ID generator, assets API + calculated age/warranty, POs, contracts, attachments (local/supabase storage), timeline, Excel import, web list/form/detail/import wizard. Key-field edits by non-admins are stored as `approval_requests`; the approve/reject flow is Phase 5.
- [~] Phase 3 Complaints, expenses, first demo: code built and tested (complaints workflow, metrics, expenses, board, asset tabs); `render.yaml`, `apps/web/vercel.json` and `docs/deployment.md` written. Supabase project + private bucket created; Render API and Vercel web **not yet deployed** (see `docs/deployment.md` → Current state).
- [x] Phase 4 PMS, calibration, reminders built: versioned PMS checklists + builder, server-dated read-only PMS records (DB trigger blocks UPDATE/DELETE; corrections are linked new records), calibration with certificates, due lists, daily 06:00 pg-boss reminders (30/15/5, one per person per threshold, catch-up on startup), optional SMTP, notification bell, print view. Tests run serially (`--test-concurrency=1`) because files share one DB.
- [ ] Phase 5 Approvals, condemnation, reports, packaging — next.

Demo logins after `npm run db:seed -w apps/api` (password `Demo@1234`): superadmin@, admin@, biomed@, nursing@ `demo.local`.

Update this Status section at the end of each phase.

## Source documents

Design and plan were written in claude.ai (Project "Bio Medical Web App"); condensed copies live in `docs/`. Original requirements came from a recorded meeting (in Gujarati) with the hospital's biomedical team.
