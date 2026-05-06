#!/usr/bin/env bash
#
# fixture-base.sh — populate the local dev environment with the base
# fixture (admin user + cross-app seed data).
#
# Composes two existing tools into one command:
#   1. provision-admin.sh — idempotent, ensures admin@example.com exists
#   2. seed sidecar       — runs scripts/seed-all.mjs against the live stack
#
# Use after `node scripts/dev/up.mjs` to get a fully populated dev
# environment in one step. The admin step is idempotent; the seed step is
# additive — re-running this against an already-populated stack is safe
# but may add additional seeded artifacts.
#
# Usage:
#   ./scripts/dev/fixture-base.sh
set -euo pipefail

# Source the shared preflight helpers.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"
assert_repo_root

echo "[1/2] provisioning dev admin..."
"${SCRIPT_DIR}/provision-admin.sh"
echo ""

echo "[2/2] running seed sidecar (docker compose --profile seed run --rm seed)..."
docker compose --profile seed run --rm seed
echo ""

# Read HTTP_PORT for the post-banner URL hint.
HTTP_PORT=$(read_env_var HTTP_PORT)
PORT_SUFFIX=""
[ -n "$HTTP_PORT" ] && [ "$HTTP_PORT" != "80" ] && PORT_SUFFIX=":${HTTP_PORT}"

echo "Dev fixture complete."
echo "  Browser: http://localhost${PORT_SUFFIX}/b3/"
echo "  Login:   admin@example.com / (password in .local-dev-state.json under devAdmin)"
echo "  Quick lookup: node scripts/lib/read-state.mjs devAdmin DEV_ADMIN_PASSWORD"
