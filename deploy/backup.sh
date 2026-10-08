#!/usr/bin/env bash
# Nightly backup of the database and the uploaded files, keeping the last KEEP_DAYS days (default 14).
#   bash backup.sh        run forever, backing up every night at BACKUP_HOUR (default 02, in the container's TZ)
#   bash backup.sh once   back up now and exit (also what "docker compose exec backup bash /backup.sh once" runs)
set -euo pipefail
umask 077 # backups hold the whole hospital database: readable by the owner only

BACKUP_DIR="${BACKUP_DIR:-/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"
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

  # Keep the last KEEP_DAYS days.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' -o -name '*.partial' \) -mtime "+$((KEEP_DAYS - 1))" -delete
  echo "$(date '+%F %T') backup $ts done: $(ls "$BACKUP_DIR" | grep -c '^db-') database backups kept"
}

if [ "${1:-}" = "once" ]; then
  backup_once
  exit 0
fi

while true; do
  now="$(date +%s)"
  next="$(date -d "today $(printf '%02d' "$BACKUP_HOUR"):00" +%s)"
  [ "$next" -le "$now" ] && next="$(date -d "tomorrow $(printf '%02d' "$BACKUP_HOUR"):00" +%s)"
  echo "$(date '+%F %T') next backup at $(date -d "@$next" '+%F %T')"
  sleep "$((next - now))"
  backup_once || echo "$(date '+%F %T') BACKUP FAILED"
done
