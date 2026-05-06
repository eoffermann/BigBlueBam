#!/usr/bin/env bash
#
# preflight.sh — sourceable bash helpers used by the dev-pipeline scripts.
#
# Each helper exits the process (exit 1) on failure with a clear message,
# so callers don't have to thread error-handling. Helpers are idempotent
# and safe to call in any order.
#
# Usage (from a script in scripts/dev/, scripts/data/, or scripts/):
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "${SCRIPT_DIR}/../lib/preflight.sh"        # from scripts/dev/
#   # source "${SCRIPT_DIR}/lib/preflight.sh"         # from scripts/
#   assert_repo_root
#   assert_docker_running
#   assert_env_file
#
# Helpers exported:
#   assert_repo_root              — cwd must be repo root (presence of
#                                   docker-compose.yml + apps/api/)
#   assert_docker_running         — docker info must exit 0
#   assert_env_file               — .env must exist (points to configure.sh on miss)
#   assert_postgres_healthy       — pg_isready must succeed (requires .env + stack)
#   read_env_var <KEY>            — echoes the value or empty
#   assert_env_var <KEY> [<hint>] — fails with optional hint if key missing
#
# Note: this file is meant to be SOURCED, not executed directly. Each
# helper is a function; calling `bash scripts/lib/preflight.sh` is a no-op.

assert_repo_root() {
  if [ ! -f "docker-compose.yml" ] || [ ! -d "apps/api" ]; then
    echo "[fail] Run from the BigBlueBam repository root (cwd missing docker-compose.yml or apps/api/)." >&2
    exit 1
  fi
}

assert_docker_running() {
  if ! docker info >/dev/null 2>&1; then
    echo "[fail] Docker daemon not reachable. Start Docker Desktop and re-run." >&2
    exit 1
  fi
}

assert_env_file() {
  if [ ! -f ".env" ]; then
    echo "[fail] No .env found. Configure the local Docker dev environment first:" >&2
    echo "  Interactive:     ./scripts/dev/configure.sh" >&2
    echo "  Non-interactive: ./scripts/dev/configure.sh -y" >&2
    exit 1
  fi
}

# Read a single key from .env. Echoes value (without quotes if surrounding)
# or empty string. Trailing whitespace and surrounding quotes are stripped.
read_env_var() {
  local key="$1" line value
  line=$(grep -E "^${key}=" .env 2>/dev/null | head -1 || true)
  [ -z "$line" ] && return 0
  value="${line#${key}=}"
  # Strip surrounding double or single quotes.
  if [[ "$value" =~ ^\".*\"$ ]] || [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

# Assert that a .env key is present and non-empty. Optional second arg is a
# hint shown in the error message.
assert_env_var() {
  local key="$1" hint="${2:-}" value
  value=$(read_env_var "$key")
  if [ -z "$value" ]; then
    echo "[fail] ${key} missing from .env." >&2
    [ -n "$hint" ] && echo "        ${hint}" >&2
    exit 1
  fi
}

assert_postgres_healthy() {
  local pg_user
  pg_user=$(read_env_var POSTGRES_USER)
  if [ -z "$pg_user" ]; then
    echo "[fail] POSTGRES_USER missing from .env." >&2
    exit 1
  fi
  if ! docker compose exec -T postgres pg_isready -U "$pg_user" -d bigbluebam >/dev/null 2>&1; then
    echo "[fail] postgres is not ready. Bring the stack up first:" >&2
    echo "  node scripts/dev/up.mjs" >&2
    exit 1
  fi
}
