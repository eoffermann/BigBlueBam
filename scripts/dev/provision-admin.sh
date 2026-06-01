#!/usr/bin/env bash
#
# provision-admin.sh — idempotently ensure the dev admin user exists.
#
# Reads DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD / DEV_ADMIN_ORG_NAME from .env
# (composed by scripts/dev/configure.sh). Checks postgres for the user; if
# missing, calls `docker compose exec api node dist/cli.js create-admin`
# with --superuser so the bootstrap-gate clears immediately. If the user
# exists but is_superuser=false, promotes via `grant-superuser`.
#
# Pre-flight requires the stack to be up and postgres healthy. This script
# does NOT bring the stack up; pair with scripts/dev/up.mjs.
#
# Usage:
#   ./scripts/dev/provision-admin.sh
#
# Caveat (password drift): this script DOES NOT rotate an existing admin's
# password. If you change DEV_ADMIN_PASSWORD in .env after the admin has
# been created, the DB still has the Argon2id hash of the old password.
# To rotate, use the in-app password reset flow, or manually delete the
# users row + re-run this script.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"

assert_repo_root
assert_env_file

# POSTGRES_USER lives in .env (consumed by docker-compose). Dev-admin keys
# live in .local-dev-state.json (orchestration metadata, not service config).
assert_env_var POSTGRES_USER
POSTGRES_USER="$(read_env_var POSTGRES_USER)"

DEV_ADMIN_EMAIL="$(node "${SCRIPT_DIR}/../lib/read-state.mjs" devAdmin DEV_ADMIN_EMAIL)"
DEV_ADMIN_PASSWORD="$(node "${SCRIPT_DIR}/../lib/read-state.mjs" devAdmin DEV_ADMIN_PASSWORD)"
DEV_ADMIN_ORG_NAME="$(node "${SCRIPT_DIR}/../lib/read-state.mjs" devAdmin DEV_ADMIN_ORG_NAME)"

if [ -z "$DEV_ADMIN_EMAIL" ] || [ -z "$DEV_ADMIN_PASSWORD" ] || [ -z "$DEV_ADMIN_ORG_NAME" ]; then
  echo "[fail] dev-admin keys missing from .local-dev-state.json." >&2
  echo "        Re-run ./scripts/dev/configure.sh -y to (re)generate them." >&2
  exit 1
fi

assert_postgres_healthy

# Idempotency check: does the admin already exist, and if so are they a
# platform SuperUser? The bootstrap-gate (apps/api/src/services/bootstrap-status.service.ts)
# checks for a non-sentinel SuperUser specifically — an org owner without
# is_superuser leaves /b3/ redirecting to /b3/bootstrap, which is the
# symptom this branch defends against.
SU_STATUS=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d bigbluebam -tAc \
  "SELECT is_superuser FROM users WHERE email='${DEV_ADMIN_EMAIL}' LIMIT 1" 2>/dev/null | tr -d '[:space:]')

case "$SU_STATUS" in
  t)
    # Exists AND is a SuperUser — nothing to do.
    echo "[ok] dev admin already provisioned (${DEV_ADMIN_EMAIL})"
    exit 0
    ;;
  f)
    # Exists but not a SuperUser — promote via the existing grant-superuser CLI verb.
    echo "Found ${DEV_ADMIN_EMAIL} but is_superuser=false. Promoting..."
    if ! docker compose exec -T api node dist/cli.js grant-superuser --email "$DEV_ADMIN_EMAIL"; then
      echo "[fail] grant-superuser failed. See output above." >&2
      exit 1
    fi
    echo "[ok] ${DEV_ADMIN_EMAIL} promoted to SuperUser."
    exit 0
    ;;
  '')
    # Doesn't exist — fall through to create-admin below.
    ;;
  *)
    echo "[fail] unexpected is_superuser value from postgres: '${SU_STATUS}'" >&2
    exit 1
    ;;
esac

# Create the admin via the api CLI. --superuser promotes them at create
# time so the bootstrap-gate clears immediately.
echo "Creating dev admin (${DEV_ADMIN_EMAIL})..."
if ! docker compose exec -T api node dist/cli.js create-admin \
       --email "$DEV_ADMIN_EMAIL" \
       --password "$DEV_ADMIN_PASSWORD" \
       --name "Dev Admin" \
       --org "$DEV_ADMIN_ORG_NAME" \
       --superuser; then
  echo "[fail] create-admin failed. See output above." >&2
  exit 1
fi

echo ""
echo "[ok] Dev admin provisioned."
echo "    Email:    ${DEV_ADMIN_EMAIL}"
echo "    Password: see DEV_ADMIN_PASSWORD in .env"
echo "    Org:      ${DEV_ADMIN_ORG_NAME}"
