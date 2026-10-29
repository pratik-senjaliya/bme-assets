# Demo deployment (Vercel + Render + Supabase)

Cloud demo for stakeholders. Supabase is **only** hosted Postgres and file storage; all logic stays in the Express API, so the same code runs on-prem (Phase 5).

```
Browser → Vercel (Next.js) ── /api/v1/* proxied to API_URL ──▶ Render (Express API) ──▶ Supabase Postgres + Storage
```

The browser only talks to the Vercel URL, so the login cookie is first-party.

## Current state

**Live demo: https://bme-assets.vercel.app** (health: `https://bme-assets.vercel.app/api/v1/health`).

| Piece | State |
|---|---|
| Supabase project `bme-assets-demo` (ref `uxxixezpmhqaxrmlnbki`, Mumbai, `https://uxxixezpmhqaxrmlnbki.supabase.co`) | Running. Private bucket `bme-files` (10 MB, PDF/JPG/PNG). |
| Render API | Running (version 1.6.1 on 29 Oct 2026). Its URL is Vercel's `API_URL`; `WEB_ORIGIN` = `https://bme-assets.vercel.app`. |
| Vercel web | Running at `https://bme-assets.vercel.app`. The project is not under the Vercel login connected to Claude, so automation cannot see it. |
| Demo data | Full demo hospital (`npm run db:demo`), loaded 29 Oct 2026 from a local machine with the Render values in `apps/api/.env.live` (gitignored); see "Reloading the full demo" below. |
| Database password / connection strings | Not available to automation: copy them from Render → the API service → Environment. |

## 1. Supabase (database + files)

1. Create a project (region close to the hospital, e.g. Mumbai/Singapore). Save the database password.
2. **Connection strings** (Project → Connect):
   - Replace `[PASSWORD]` with the database password and `<ref>` with `uxxixezpmhqaxrmlnbki`.
   - `DATABASE_URL`: transaction pooler, port 6543, add `?pgbouncer=true&connection_limit=1`.
   - `DIRECT_URL`: direct connection (port 5432). If Render cannot reach it (IPv6 only on the free tier), use the **session pooler** string instead (host `…pooler.supabase.com`, port 5432).
3. **Storage**: create a **private** bucket named `bme-files`.
4. `SUPABASE_URL` = project URL; `SUPABASE_SERVICE_KEY` = the `service_role` key. Server-side only: it goes in Render, never in Vercel or the browser.

No Supabase Auth, RLS or edge functions are used.

## 2. Render (API)

1. New → Blueprint → pick this repo (`render.yaml`). Fill the `sync: false` values: `DATABASE_URL`, `DIRECT_URL`, `WEB_ORIGIN` (the Vercel URL, set after step 3), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
2. The service builds, runs `prisma migrate deploy`, then starts. Check `https://<api>.onrender.com/api/v1/health` → `"database":"up"`.
3. **Seed the demo data once** (the seed also adds any missing permission codes): Render dashboard → the service → Shell → `cd apps/api && npx prisma db seed`.
4. `TRUST_PROXY=2` (Vercel + Render in front) and `COOKIE_SECURE=true` (HTTPS) are already in the blueprint.

The daily reminder job (pg-boss, 06:00 Asia/Kolkata) runs inside this service, on the **direct** connection (`DIRECT_URL`); it keeps its schedule in a `pgboss` schema it creates itself. The reminder check also runs at every start and is safe to repeat (one reminder per person per threshold), so a sleeping free-plan service catches up when it wakes. For a demo you can also press **Run reminders now** in Admin > Hospital settings. Set `DISABLE_JOBS=true` on any second instance.

The free plan sleeps after ~15 minutes idle; the first request after that takes 30–60 s. Open the health URL a minute before a demo.

## 3. Vercel (web)

1. Import the repo; set **Root Directory** to `apps/web` and keep "Include source files outside of the Root Directory" on. `apps/web/vercel.json` sets the install and build commands. It also pins the functions to Mumbai (`"regions": ["bom1"]`): the `/api/v1` proxy runs as a function, and Vercel's default (Washington, `iad1`) sent every request from India to the USA and back before it reached the API in Singapore.
2. Environment variable `API_URL` = `https://<api>.onrender.com` (Production and Preview). It is read at **runtime** by the `/api/v1` proxy function, so changing it needs no rebuild, only a new deployment or an env redeploy.
3. Deploy, then put the Vercel URL into Render's `WEB_ORIGIN`.

### How the services connect (bindings)

| Caller | Target | Binding | Where it is read |
|---|---|---|---|
| web | api | `API_URL` | `apps/web/src/app/api/v1/[...path]/route.ts`, per request |

The browser never learns the API address: it calls `/api/v1/*` on the web origin and the proxy forwards to `API_URL` + `api/v1/...`. Bindings are read inside functions only, never at build time (`next.config.ts` has no API address) and never in middleware (there is none). Vercel limits a function's request body to 4.5 MB, so uploads over that (the app allows 10 MB) only work where the proxy is not a Vercel function (self-hosted `next start`, i.e. on-prem Docker) or if the browser reaches the API without that hop.

## Demo logins (password `Demo@1234`)

| Login | Role |
|---|---|
| `nursing@demo.local` | Nursing, ICU |
| `biomed@demo.local` | Biomedical staff |
| `admin@demo.local` | Admin (HOD) |
| `superadmin@demo.local` | Super admin (vendor) |

Change `SEED_PASSWORD` before seeding if the link is shared widely. The full demo adds more logins (deputy HOD, maintenance, ward logins): see the demo line in `CLAUDE.md`.

### Reloading the full demo

It **wipes the live database** first. Put the Render values (`DATABASE_URL`, `DIRECT_URL`, `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`, `APP_TIMEZONE`) in `apps/api/.env.live`, then:

```bash
cd apps/api && set -a && . ./.env.live && set +a && npm run db:demo
```

Values already in the environment win over `.env`, so both Prisma and the seed go to Supabase. It takes about 6 minutes over the network; generated certificates and photos go to the Supabase bucket.

## Click path for the demo

1. **Nursing** signs in → *Assets* shows only ICU equipment → row menu → **Raise complaint** ("Ventilator alarm keeps sounding") → toast shows `CMP-000x`.
2. **Biomedical** signs in → *Complaints* board: the complaint is in **Open** with a waiting time → **Start work** → it moves to **In progress** with the response time → **Resolve** with notes → **Recently resolved** shows the downtime.
3. Same user → open the asset → **Complaints** tab shows the history; **Expenses** tab → add a spare-part cost linked to the complaint.
4. **Nursing** refreshes → sees the complaint resolved; has no *Expenses* tab and no admin menu.
5. **Biomedical** → *Due & overdue* → **Perform PMS** on an overdue ventilator (the date is set by the system, shown locked) → open the record → **Print**; then **Record a correction** to show the original is kept. Check the bell for reminders.
6. **Admin** → *PMS checklists* → add an item → saved as a new version; old records keep theirs.
7. **Admin** → *Assets* → edit a serial number as biomed to show the HOD-approval request (decision screen arrives in Phase 5).

## Check: full round trip on the live link

Repeat steps 1–4 on the deployed URL with two browsers (or one normal and one private window). Response time and downtime must show plausible durations, and the asset timeline should list both complaint events.
