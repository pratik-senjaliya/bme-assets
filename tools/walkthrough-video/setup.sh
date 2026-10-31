#!/bin/bash
# Builds the separate demo database `bme_video` (never the working `bme` one), then starts a production build of the
# API on :4100 and the web app on :3100 against it. Run again before every take: the walkthrough changes data.
# Needs the dev Postgres container (npm run db:up) and a built app (npm run build).
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd); OUT=${VIDEO_OUT:-$HERE/out}
DB=${VIDEO_DB:-bme_video}; CONTAINER=${VIDEO_PG_CONTAINER:-bme-ui-db}
mkdir -p "$OUT"
# Stop an earlier run of this script (by port, so nothing else is touched).
for port in 3100 4100; do pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill "$pid" || true; done
sleep 1
docker exec "$CONTAINER" psql -U bme -d bme -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
rm -rf "$OUT/uploads"
export DATABASE_URL="postgresql://bme:bme@localhost:5434/$DB" DIRECT_URL="postgresql://bme:bme@localhost:5434/$DB" STORAGE_PATH="$OUT/uploads"
cd "$ROOT/apps/api"
npx prisma migrate deploy >/dev/null           # an empty database: migrate deploy, not reset
npx tsx --env-file=.env src/seedDemo.ts | head -1
PORT=4100 WEB_ORIGIN=http://localhost:3100 nohup node --env-file=.env dist/index.js > "$OUT/api.log" 2>&1 &
cd "$ROOT/apps/web"
API_URL=http://localhost:4100 nohup npx next start -p 3100 > "$OUT/web.log" 2>&1 &
for i in $(seq 1 60); do curl -sf localhost:3100/api/v1/health >/dev/null && break; sleep 1; done
curl -sf localhost:3100/api/v1/health >/dev/null && echo "ready on http://localhost:3100" || { echo "not ready, see $OUT/*.log"; exit 1; }
