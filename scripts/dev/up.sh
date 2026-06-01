#!/usr/bin/env bash
#
# up.sh — bring up the BigBlueBam local Docker dev stack.
#
# Thin bash wrapper around up.mjs for ergonomic parity with the rest of the
# scripts/dev/ entry points. The actual logic lives in up.mjs (pure stack
# runner, requires .env to already exist; pair with scripts/dev/configure.sh
# to compose .env first).
#
# Usage:
#   ./scripts/dev/up.sh
#
# Or via VS Code: Cmd+Shift+P → Tasks: Run Task → "Dev: Up"
set -euo pipefail
exec node "$(dirname "$0")/up.mjs" "$@"
