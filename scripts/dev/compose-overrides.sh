#!/usr/bin/env bash
#
# compose-overrides.sh — manage per-service dev overrides for the
# local-Docker dev workflow.
#
# Generates docker-compose.override.yml (gitignored, per-developer file
# that compose auto-merges) with two supported override patterns:
#
#   - Node services (tsup→node): runs the prod Dockerfile's `deps` stage
#     with bind-mounted source + tsup --watch + node --watch. Same
#     `node dist/<entry>.js` runtime as prod, ~1-2s rebuild on save.
#   - Vite SPAs (vite build --watch): spawns a <spa>-dev-builder sidecar
#     that runs `vite build --watch` against bind-mounted source, writing
#     to apps/<spa>/dist/. The gateway nginx mounts that dist/ over its
#     baked-in copy. Same prod-built bundle, ~1-3s rebuild on save, full
#     page reload (no HMR).
#
# Usage:
#   ./scripts/dev/compose-overrides.sh help
#   ./scripts/dev/compose-overrides.sh list [overridden|available]
#   ./scripts/dev/compose-overrides.sh add <service>
#   ./scripts/dev/compose-overrides.sh remove <service>
#   ./scripts/dev/compose-overrides.sh clear
#   ./scripts/dev/compose-overrides.sh show
#
# After add/remove, run `node scripts/dev/up.mjs` (or VS Code → Tasks: Run
# Task → "Dev: Up") to bring the stack into sync.
set -euo pipefail
exec node "$(dirname "$0")/compose-overrides/main.mjs" "$@"
