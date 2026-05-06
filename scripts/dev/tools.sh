#!/usr/bin/env bash
#
# tools.sh — run a workspace tooling command inside the workspace container.
# Wraps any pnpm script defined at the repo root: typecheck, lint, format,
# check, db:check, lint:migrations, and so on.
#
# Examples:
#   ./scripts/dev/tools.sh typecheck         # tsc --noEmit across workspaces
#   ./scripts/dev/tools.sh lint              # Biome lint via turbo
#   ./scripts/dev/tools.sh format            # Biome format --write (writes back)
#   ./scripts/dev/tools.sh check             # Biome check --write
#   ./scripts/dev/tools.sh db:check          # Drizzle drift guard (needs stack up)
#   ./scripts/dev/tools.sh lint:migrations   # migration file linter
#
# For test runs, use scripts/dev/test.sh instead.
#
# Always passes --build to docker compose run for cache-correctness on
# Dockerfile or lockfile changes; layer caching keeps the no-change cost low.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  cat >&2 <<'USAGE'
tools.sh — run a pnpm tooling command inside the workspace container.

Usage:
  scripts/dev/tools.sh <verb> [args...]

Common verbs: typecheck, lint, format, check, db:check, lint:migrations.
For tests, use scripts/dev/test.sh instead.
USAGE
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"

assert_repo_root
assert_docker_running

exec docker compose --profile test run --build --rm workspace pnpm "$@"
