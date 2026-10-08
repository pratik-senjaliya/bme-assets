# BME Asset Management

Web app for hospital biomedical departments: equipment register, lifecycle history, PMS, calibration, complaints, approvals, reminders and Excel reports. Runs on the hospital's own server; a cloud demo is used for stakeholders.

## Quick start

Requires Node 20+ and Docker.

```bash
npm install
npm run db:up
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run prisma:migrate -w apps/api -- --name init   # first time only: creates the tables
npm run db:seed -w apps/api                         # demo hospital and logins (password Demo@1234)
npm run dev:api     # terminal 1 → http://localhost:4000/api/v1/health
npm run dev:web     # terminal 2 → http://localhost:3000
npm test -w apps/api                                # integration tests (need the seeded database)
```

Sign in at <http://localhost:3000> as `admin@`, `biomed@`, `nursing@` or `superadmin@demo.local`.

## Installing for a hospital

Docker Compose install with nightly backups: [docs/install.md](docs/install.md). Upgrades: [docs/upgrade.md](docs/upgrade.md).
The cloud demo (Vercel + Render + Supabase): [docs/deployment.md](docs/deployment.md).

## Repo layout

```
apps/web         Next.js frontend
apps/api         Express + Prisma API
packages/shared  types and schemas shared by both
docs/            architecture, plan, install, upgrade and deployment guides
deploy/          Caddy config and backup script used by docker-compose.yml
CLAUDE.md        context for Claude Code sessions
```

See `docs/architecture.md` and `docs/implementation-plan.md`.
