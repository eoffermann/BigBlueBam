#!/usr/bin/env bash
# dump_data_vols.sh -- capture the contents of all data volumes to
# timestamped tarballs for pre-upgrade snapshot / rollback.
# Pairs with restore_data_vols.sh.
#
# Usage:
#   ./scripts/dump_data_vols.sh <target_dir>
#
# Stops the data services first:
#   docker compose stop postgres redis minio qdrant
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_ROOT"

usage() {
  cat >&2 <<EOF
usage: $0 <target_dir>
  Captures pgdata, redisdata, miniodata, qdrantdata to
  <target_dir>/<UTC-timestamp>/<vol>.tar.gz plus a manifest.txt.
  Refuses if postgres, redis, minio, or qdrant is running --
  stop them first with: docker compose stop postgres redis minio qdrant
EOF
  exit 2
}

[ $# -eq 1 ] || usage
TARGET=$1

PROJECT=${COMPOSE_PROJECT_NAME:-bigbluebam}
VOLUMES=(pgdata redisdata miniodata qdrantdata)
SERVICES=(postgres redis minio qdrant)

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker is not reachable" >&2
  exit 1
fi
if ! docker compose ps >/dev/null 2>&1; then
  echo "ERROR: docker compose ps failed (is docker-compose.yml present in $PROJECT_ROOT?)" >&2
  exit 1
fi

running=()
for svc in "${SERVICES[@]}"; do
  ids=$(docker compose ps -q "$svc")
  if [ -n "$ids" ]; then
    running+=("$svc")
  fi
done
if [ ${#running[@]} -gt 0 ]; then
  echo "ERROR: data services still running: ${running[*]}" >&2
  echo "       run: docker compose stop ${SERVICES[*]}" >&2
  exit 1
fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$TARGET/$ts"
out=$(cd "$TARGET/$ts" && pwd)

echo "Dumping to $out"

for vol in "${VOLUMES[@]}"; do
  full="${PROJECT}_${vol}"
  if ! docker volume inspect "$full" >/dev/null 2>&1; then
    echo "  WARN: volume $full does not exist; skipping" >&2
    continue
  fi
  echo "  $full -> $vol.tar.gz"
  docker run --rm \
    -v "$full:/from:ro" \
    -v "$out:/to" \
    alpine \
    tar -czf "/to/$vol.tar.gz" -C /from .
done

{
  echo "timestamp=$ts"
  echo "project=$PROJECT"
  echo "git_sha=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "host=$(hostname)"
  echo "user=$(id -un)"
  echo ""
  echo "files:"
  for f in "$out"/*.tar.gz; do
    [ -e "$f" ] || continue
    sz=$(du -h "$f" | awk '{print $1}')
    printf "  %-20s %s\n" "$(basename "$f")" "$sz"
  done
} > "$out/manifest.txt"

echo "OK: dump complete"
echo "$out"
