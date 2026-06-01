#!/usr/bin/env bash
#
# ci.sh — run the local-runnable subset of the CI verification suite in
# one workspace container. Mirrors lint.yml + typecheck.yml + test.yml +
# the static parts of db-drift.yml, in the order CI runs them. Exits
# non-zero on the first failure.
#
# Coverage map (CI workflow → step here):
#
#   lint.yml             → pnpm lint, pnpm lint:migrations,
#                          pnpm check:permission-catalog
#   typecheck.yml        → build shared packages, then per-workspace
#                          typecheck
#   test.yml             → pnpm -r --parallel --if-present test
#                          (the migration step is skipped — tests are
#                          mocked and don't need a live DB; if a test
#                          ever grows a real-DB dependency, start the
#                          stack first with `node scripts/dev/up.mjs`)
#   db-drift.yml         → static parts only (db-check.coverage.test +
#                          check-tool-return-coverage). The pnpm db:check
#                          step is skipped — it needs the stack up. Run
#                          `bash scripts/dev/tools.sh db:check` after
#                          `node scripts/dev/up.mjs` for that coverage.
#   migration-replay.yml → NOT covered. Replaying every migration on a
#                          fresh postgres requires sidecar orchestration
#                          we don't wrap yet.
#
# Run before pushing to catch the same failures CI would catch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"

assert_repo_root
assert_docker_running

workspace_run sh -c '
  set -e

  echo "═══ lint.yml ═══"
  echo "--- pnpm lint ---"
  pnpm lint
  echo "--- pnpm lint:migrations ---"
  pnpm lint:migrations
  echo "--- pnpm check:permission-catalog ---"
  pnpm check:permission-catalog

  echo "═══ typecheck.yml ═══"
  echo "--- build shared packages ---"
  pnpm -r --filter "./packages/*" --if-present run build
  echo "--- typecheck ---"
  pnpm -r --parallel --if-present typecheck

  echo "═══ test.yml ═══"
  echo "--- vitest (mocked) ---"
  pnpm -r --parallel --if-present test

  echo "═══ db-drift.yml (static parts) ═══"
  echo "--- db-check coverage ---"
  node scripts/db-check.coverage.test.mjs
  echo "--- mcp tool return-schema coverage ---"
  node scripts/check-tool-return-coverage.mjs

  echo "═══ all local CI checks green ═══"
'
