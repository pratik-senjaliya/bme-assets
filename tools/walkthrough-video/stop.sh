#!/bin/bash
# Stops the servers started by setup.sh and drops the demo database.
for port in 3100 4100; do pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill "$pid" || true; done
docker exec "${VIDEO_PG_CONTAINER:-bme-ui-db}" psql -U bme -d bme -qc "DROP DATABASE IF EXISTS ${VIDEO_DB:-bme_video} WITH (FORCE)"
echo stopped
