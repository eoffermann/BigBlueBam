#!/usr/bin/env bash
#
# lint.sh — run the full CI lint sequence inside one workspace container.
# Mirrors .github/workflows/lint.yml exactly: pnpm lint + pnpm lint:migrations
# + pnpm check:permission-catalog. Exits non-zero on the first failure.
#
# All three commands are static (no DB needed). For one-off per-command
# runs use scripts/dev/tools.sh <verb> instead — this wrapper exists so
# the three-step sequence runs in a single container (no parallel-build
# collisions, faster than three separate invocations).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"

assert_repo_root
assert_docker_running

workspace_run sh -c '
  set -e
  echo "=== pnpm lint ==="
  pnpm lint
  echo "=== pnpm lint:migrations ==="
  pnpm lint:migrations
  echo "=== pnpm check:permission-catalog ==="
  pnpm check:permission-catalog
'
