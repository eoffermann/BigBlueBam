#!/usr/bin/env bash
#
# test.sh — run the Vitest suite inside the workspace container.
# All args after the script name are passed through to vitest.
#
# Examples:
#   ./scripts/dev/test.sh                                   # full suite
#   ./scripts/dev/test.sh --filter @bigbluebam/api          # vitest filter
#   ./scripts/dev/test.sh path/to/file.test.ts              # single file
#
# DB-coupled tests need the stack's postgres + redis up. Run
# `node scripts/dev/up.mjs` first if you see "connection refused" — the
# workspace container joins the backend network and connects to
# postgres:5432 / redis:6379, but does NOT start them itself.
#
# For non-test commands (typecheck / lint / format / db:check), use
# scripts/dev/tools.sh instead.
#
# Always passes --build to docker compose run, so a stale image after a
# Dockerfile or package.json change never silently misleads you. Layer
# caching keeps the no-change overhead small.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"

assert_repo_root
assert_docker_running

exec docker compose --profile test run --build --rm workspace pnpm test "$@"
