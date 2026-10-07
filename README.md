# BME Asset Management

Web app for hospital biomedical departments: equipment register, lifecycle history, PMS, calibration, complaints, approvals, reminders and Excel reports. Runs on the hospital's own server; a cloud demo is used for stakeholders.

## Quick start

Requires Node 20+ and Docker.

```bash
npm install
npm run db:up
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run dev:api     # terminal 1 → http://localhost:4000/api/v1/health
npm run dev:web     # terminal 2 → http://localhost:3000
```

The home page should show `Database: up`.

## Repo layout

```
apps/web         Next.js frontend
apps/api         Express + Prisma API
packages/shared  types and schemas shared by both
docs/            architecture and implementation plan
CLAUDE.md        context for Claude Code sessions
```

See `docs/architecture.md` and `docs/implementation-plan.md`.
