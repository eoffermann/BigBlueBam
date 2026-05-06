# BigBlueBam workspace image — first-class build artifact with the full
# pnpm workspace installed (every app, every package, frozen lockfile).
# Used for tests, typecheck, lint, format, db:check, migration linting,
# and the Vite Level-1 dev-builder sidecars. Bakes in
# `pnpm install --frozen-lockfile` once; source is bind-mounted at runtime
# via docker-compose.yml's `workspace` service so edits don't trigger
# rebuilds. Devs, CI, and ops engineers all run the same image.
#
# Usage (via wrappers, recommended):
#   ./scripts/dev/test.sh                    # full Vitest suite
#   ./scripts/dev/test.sh --filter @x/y      # vitest filter args
#   ./scripts/dev/tools.sh typecheck         # tsc --noEmit
#   ./scripts/dev/tools.sh check             # Biome
#   ./scripts/dev/tools.sh db:check          # Drizzle drift guard
#
# Or directly:
#   docker compose --profile test build workspace
#   docker compose --profile test run --rm workspace pnpm <verb>
#
# Cache invalidation: only manifests + lockfile invalidate the install
# layer. New workspaces require a rebuild — add a COPY line below for the
# new workspace's package.json.

FROM node:22-alpine

# Pinned via package.json's `packageManager` field (pnpm@9.15.4).
RUN corepack enable

WORKDIR /app

# ── Layer 1: workspace manifests ──────────────────────────────────────
# Copy lockfile + every workspace's package.json. Done before source so
# pnpm install can be cached when only source changes (and bind-mounted
# source overrides the COPY of source below at runtime).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Backend APIs (14)
COPY apps/api/package.json ./apps/api/
COPY apps/banter-api/package.json ./apps/banter-api/
COPY apps/beacon-api/package.json ./apps/beacon-api/
COPY apps/bearing-api/package.json ./apps/bearing-api/
COPY apps/bench-api/package.json ./apps/bench-api/
COPY apps/bill-api/package.json ./apps/bill-api/
COPY apps/blank-api/package.json ./apps/blank-api/
COPY apps/blast-api/package.json ./apps/blast-api/
COPY apps/board-api/package.json ./apps/board-api/
COPY apps/bolt-api/package.json ./apps/bolt-api/
COPY apps/bond-api/package.json ./apps/bond-api/
COPY apps/book-api/package.json ./apps/book-api/
COPY apps/brief-api/package.json ./apps/brief-api/
COPY apps/helpdesk-api/package.json ./apps/helpdesk-api/

# Frontend SPAs (14)
COPY apps/banter/package.json ./apps/banter/
COPY apps/beacon/package.json ./apps/beacon/
COPY apps/bearing/package.json ./apps/bearing/
COPY apps/bench/package.json ./apps/bench/
COPY apps/bill/package.json ./apps/bill/
COPY apps/blank/package.json ./apps/blank/
COPY apps/blast/package.json ./apps/blast/
COPY apps/board/package.json ./apps/board/
COPY apps/bolt/package.json ./apps/bolt/
COPY apps/bond/package.json ./apps/bond/
COPY apps/book/package.json ./apps/book/
COPY apps/brief/package.json ./apps/brief/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/helpdesk/package.json ./apps/helpdesk/

# Other Node services (2) + test packages (2)
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY apps/worker/package.json ./apps/worker/
COPY apps/e2e/package.json ./apps/e2e/
COPY apps/integration-tests/package.json ./apps/integration-tests/

# Workspace packages (7)
COPY packages/db-stubs/package.json ./packages/db-stubs/
COPY packages/docs-capture/package.json ./packages/docs-capture/
COPY packages/livekit-tokens/package.json ./packages/livekit-tokens/
COPY packages/logging/package.json ./packages/logging/
COPY packages/service-health/package.json ./packages/service-health/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

# Install everything against the lockfile. --frozen-lockfile is intentional:
# tests must run against the exact dep graph the lockfile pins, otherwise CI
# parity is broken.
RUN pnpm install --frozen-lockfile

# ── Layer 2: source (offline / archive fallback) ──────────────────────
# At runtime, docker-compose.yml's `testrunner` service bind-mounts apps/
# + packages/ + the root config files over these COPYs, so edits land
# immediately. The COPY exists so the image is also self-contained
# without the bind mount (e.g., archived / shipped to ops for release
# verification).
#
# Note: at runtime, apps/ and packages/ are mounted read-write so turbo
# can create per-workspace .turbo/ log dirs and so task-graph build
# steps (e.g., packages/shared/dist/) can write back. Both .turbo/ and
# dist/ are gitignored, so the writes are non-precious.
COPY apps/ ./apps/
COPY packages/ ./packages/
# scripts/ is needed for `pnpm db:check`, `pnpm lint:migrations`, and other
# root-level pnpm scripts that exec node scripts/*.mjs.
COPY scripts/ ./scripts/
# infra/postgres/migrations is read by `pnpm lint:migrations` (and would be
# read by db:check when it inspects the migration file set). The rest of
# infra/ is irrelevant to workspace-level tooling.
COPY infra/postgres/migrations/ ./infra/postgres/migrations/
COPY tsconfig.base.json biome.json turbo.json ./

# Default: full Vitest suite. Override via `docker compose run` arg or
# the wrapper scripts:
#   docker compose --profile test run --rm workspace pnpm typecheck
#   ./scripts/dev/tools.sh typecheck
CMD ["pnpm", "test"]
