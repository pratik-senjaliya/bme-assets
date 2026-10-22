#!/usr/bin/env bash
# Nightly backup of the database, the uploaded files and the server's .env, keeping the last KEEP_DAYS days (default 14).
# Each run is recorded in the database (hospital_settings.backupLastAt / backupLastError), so Hospital settings shows
# it and the daily check tells the HOD when a backup failed or has not run.
#   bash backup.sh        run forever, backing up every night at BACKUP_HOUR (default 02, in the container's TZ)
#   bash backup.sh once   back up now and exit (also what "docker compose exec backup bash /backup.sh once" runs)
set -Eeuo pipefail # -E: the ERR trap below also fires inside functions
umask 077 # backups hold the whole hospital database: readable by the owner only

BACKUP_DIR="${BACKUP_DIR:-/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"
ENV_FILE="${ENV_FILE:-/config/.env}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_HOUR="${BACKUP_HOUR:-2}"

backup_once() {
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"

  # Written under a temporary name and renamed when complete, so a half-written file is never mistaken for a backup.
  pg_dump --no-owner --no-privileges | gzip > "$BACKUP_DIR/db-$ts.sql.gz.partial"
  gzip -t "$BACKUP_DIR/db-$ts.sql.gz.partial"
  mv "$BACKUP_DIR/db-$ts.sql.gz.partial" "$BACKUP_DIR/db-$ts.sql.gz"

  if [ -d "$UPLOADS_DIR" ]; then
    tar -C "$(dirname "$UPLOADS_DIR")" -czf "$BACKUP_DIR/uploads-$ts.tar.gz.partial" "$(basename "$UPLOADS_DIR")"
    mv "$BACKUP_DIR/uploads-$ts.tar.gz.partial" "$BACKUP_DIR/uploads-$ts.tar.gz"
  fi

  # The .env holds the passwords and secrets a rebuilt server needs (docs/install.md, "Rebuilding the server").
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$BACKUP_DIR/env-$ts.partial"
    mv "$BACKUP_DIR/env-$ts.partial" "$BACKUP_DIR/env-$ts"
  fi

  # Keep the last KEEP_DAYS days.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' -o -name 'env-*' -o -name '*.partial' \) -mtime "+$((KEEP_DAYS - 1))" -delete
  echo "$(date '+%F %T') backup $ts done: $(ls "$BACKUP_DIR" | grep -c '^db-') database backups kept"
}

# Recorded in the database for the app; a database that cannot be reached is also why the backup failed, so a failed
# record is best effort.
record() { psql -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1 || echo "$(date '+%F %T') could not record the result in the database"; }
failed() {
  local why; why="$(printf '%s' "$1" | tr -d "'")"
  echo "$(date '+%F %T') BACKUP FAILED: $why"
  record "UPDATE hospital_settings SET \"backupLastError\" = '$why', \"backupLastErrorAt\" = now()"
}

if [ "${1:-}" = "once" ]; then
  trap 'failed "stopped at line $LINENO (exit $?); see: docker compose logs backup"' ERR
  backup_once
  record "UPDATE hospital_settings SET \"backupLastAt\" = now()"
  exit 0
fi

while true; do
  now="$(date +%s)"
  next="$(date -d "today $(printf '%02d' "$BACKUP_HOUR"):00" +%s)"
  [ "$next" -le "$now" ] && next="$(date -d "tomorrow $(printf '%02d' "$BACKUP_HOUR"):00" +%s)"
  echo "$(date '+%F %T') next backup at $(date -d "@$next" '+%F %T')"
  sleep "$((next - now))"
  # A separate process, so "set -e" applies inside it (it is ignored in a function called with ||) and records a failure.
  bash "$0" once || true
done
