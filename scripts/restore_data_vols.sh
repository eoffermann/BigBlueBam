#!/usr/bin/env bash
# restore_data_vols.sh -- replace the contents of all data volumes from a
# previously-captured dump. Pairs with dump_data_vols.sh.
#
# Usage:
#   ./scripts/restore_data_vols.sh <source_dir>
#   FORCE=1 ./scripts/restore_data_vols.sh <source_dir>   # skip confirm prompt
#
# Stops the data services first:
#   docker compose stop postgres redis minio qdrant
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_ROOT"

usage() {
  cat >&2 <<EOF
usage: $0 <source_dir>
  Restores pgdata, redisdata, miniodata, qdrantdata from
  <source_dir>/<vol>.tar.gz. Wipes existing volume contents first.
  Refuses if postgres, redis, minio, or qdrant is running --
  stop them first with: docker compose stop postgres redis minio qdrant
  Set FORCE=1 to skip the y/N confirmation prompt.
EOF
  exit 2
}

[ $# -eq 1 ] || usage
SOURCE=$1
[ -d "$SOURCE" ] || { echo "ERROR: source dir does not exist: $SOURCE" >&2; exit 1; }
src=$(cd "$SOURCE" && pwd)

PROJECT=${COMPOSE_PROJECT_NAME:-bigbluebam}
VOLUMES=(pgdata redisdata miniodata qdrantdata)
SERVICES=(postgres redis minio qdrant)
FORCE=${FORCE:-0}

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

# Pre-flight: verify all archives present BEFORE doing anything destructive.
missing=()
for vol in "${VOLUMES[@]}"; do
  [ -f "$src/$vol.tar.gz" ] || missing+=("$vol.tar.gz")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: missing archive(s) in $src: ${missing[*]}" >&2
  exit 1
fi

if [ -f "$src/manifest.txt" ]; then
  echo "--- manifest ($src/manifest.txt) ---"
  cat "$src/manifest.txt"
  echo "------------------------------------"
fi

if [ "$FORCE" != "1" ]; then
  printf "This will WIPE the contents of volumes (%s) and restore from %s.\nContinue? [y/N] " "${VOLUMES[*]}" "$src"
  read -r ans
  case "$ans" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

for vol in "${VOLUMES[@]}"; do
  full="${PROJECT}_${vol}"
  docker volume create "$full" >/dev/null
  echo "  $vol.tar.gz -> $full"
  docker run --rm \
    -v "$full:/to" \
    -v "$src:/from:ro" \
    alpine \
    sh -c 'find /to -mindepth 1 -delete && tar -xzf "/from/$1.tar.gz" -C /to' _ "$vol"
done

echo "OK: restore complete from $src"
echo "Bring services back up: docker compose up -d"
