#!/usr/bin/env bash
#
# configure.sh — interactive .env composer for the LOCAL DOCKER dev posture.
#
# Composes .env for `docker compose ... up` on the developer's laptop. Does
# NOT bring up the stack (use scripts/dev/up.mjs for that). Does NOT cover
# SaaS dev deploys (Railway, Fly, etc.) or DevOps-provisioned dev environments
# — those are different deployments and warrant separate scripts.
#
# Usage:
#   ./scripts/dev/configure.sh                # interactive
#   ./scripts/dev/configure.sh -y             # non-interactive (defaults / generated)
#   ./scripts/dev/configure.sh --yes          # alias for -y
#   ./scripts/dev/configure.sh --non-interactive   # alias for -y
#
# After this finishes, run:
#   node scripts/dev/up.mjs
# (or VS Code → Tasks: Run Task → "Dev: Up")
set -euo pipefail
exec node "$(dirname "$0")/configure/main.mjs" "$@"
