#!/usr/bin/env bash
#
# decommission.sh — Tear down the local BigBlueBam stack with per-category
# control over what gets wiped. Useful for iterating on deploy-script
# behavior across fresh installs, or for selective resets (e.g., wipe the
# dev override but keep the volumes).
#
# Categories the script can wipe (each individually selectable in
# interactive mode; defaults below match the original "wipe everything but
# images" behavior so `-y` is backward-compatible):
#
#   ALWAYS RUN:
#     - Stop and remove containers (project-labeled)
#     - Remove project networks
#
#   PROMPTED (default Y in interactive mode, Y under -y):
#     - Volumes (postgres pgdata, redis, minio, qdrant) — DESTRUCTIVE for data
#     - .env                       (deploy/local-dev secrets — POSTGRES_PASSWORD etc.)
#     - .deploy-state.json         (deploy.sh resumable state)
#     - .local-dev-state.json      (configure.sh resumable state)
#     - docker-compose.override.yml  (transient dev-watch overrides)
#     - certs/                     (provisioned TLS material)
#
#   PROMPTED (default N in interactive mode and under -y):
#     - Local Docker images (bigbluebam-*:* and bigbluebam-*:dev) — slow to rebuild
#
# Resilient to partial deployments: each cleanup step is best-effort. Even
# if `docker compose down` errors (wedged container, missing overlay,
# crashed `up`), subsequent steps run anyway and the script verifies the
# final state, exiting non-zero only if something was actually left behind.
#
# Usage:
#   ./scripts/decommission.sh            # interactive, per-category prompts
#   ./scripts/decommission.sh -y         # accept all defaults (no prompts)
#   ./scripts/decommission.sh --yes      # alias for -y

# NOTE: deliberately NOT using `set -e`. Each cleanup step is best-effort;
# we want subsequent steps to run even if a prior one failed, and surface
# the failures together at the end.
set -uo pipefail

# Run from the repo root so docker compose finds the right project.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../lib/preflight.sh"
assert_repo_root

YES_FLAG=0
case "${1:-}" in
  -y|--yes) YES_FLAG=1 ;;
  '') ;;
  *) echo "Unknown argument: $1. Usage: ./scripts/dev/decommission.sh [-y|--yes]" >&2; exit 2 ;;
esac

# ── prompt helpers ─────────────────────────────────────────────────────
# ask_yn <prompt> <default ('Y'|'N')>  → echoes "1" or "0"
ask_yn() {
  local prompt="$1" default="$2" hint reply
  if [ "$default" = "Y" ]; then
    hint="[Y/n]"
  else
    hint="[y/N]"
  fi
  read -r -p "  ${prompt} ${hint} " reply
  reply="${reply:-$default}"
  case "$reply" in
    y|Y|yes|YES) echo 1 ;;
    *) echo 0 ;;
  esac
}

# ── collect per-category choices ───────────────────────────────────────
if [ "$YES_FLAG" -eq 1 ]; then
  WIPE_VOLUMES=1
  WIPE_ENV=1
  WIPE_DEPLOY_STATE=1
  WIPE_LOCAL_STATE=1
  WIPE_OVERRIDE=1
  WIPE_CERTS=1
  WIPE_IMAGES=0
else
  echo ""
  echo "Decommission options. Each category is individually selectable."
  echo "Containers and networks are always removed; choose what else to wipe."
  echo ""
  WIPE_VOLUMES=$(ask_yn       "Wipe data volumes (postgres, redis, minio, qdrant)?" "Y")
  WIPE_ENV=$(ask_yn           "Wipe .env (rotates POSTGRES_PASSWORD; only safe with volumes)?" "Y")
  WIPE_DEPLOY_STATE=$(ask_yn  "Wipe .deploy-state.json?" "Y")
  WIPE_LOCAL_STATE=$(ask_yn   "Wipe .local-dev-state.json?" "Y")
  WIPE_OVERRIDE=$(ask_yn      "Wipe docker-compose.override.yml (clears dev-watch overrides)?" "Y")
  WIPE_CERTS=$(ask_yn         "Wipe certs/ (provisioned TLS material)?" "Y")
  WIPE_IMAGES=$(ask_yn        "Remove Docker images (bigbluebam-*:*) — slow to rebuild?" "N")
  echo ""
  echo "Plan:"
  echo "  - stop + remove containers"
  echo "  - remove networks"
  [ "$WIPE_VOLUMES" -eq 1 ]      && echo "  - wipe volumes"             || echo "  - keep volumes"
  [ "$WIPE_ENV" -eq 1 ]          && echo "  - delete .env"              || echo "  - keep .env"
  [ "$WIPE_DEPLOY_STATE" -eq 1 ] && echo "  - delete .deploy-state.json" || echo "  - keep .deploy-state.json"
  [ "$WIPE_LOCAL_STATE" -eq 1 ]  && echo "  - delete .local-dev-state.json" || echo "  - keep .local-dev-state.json"
  [ "$WIPE_OVERRIDE" -eq 1 ]     && echo "  - delete docker-compose.override.yml" || echo "  - keep docker-compose.override.yml"
  [ "$WIPE_CERTS" -eq 1 ]        && echo "  - delete certs/"            || echo "  - keep certs/"
  [ "$WIPE_IMAGES" -eq 1 ]       && echo "  - remove Docker images"     || echo "  - keep Docker images"
  echo ""

  # Sanity-check the volumes/.env coupling — wiping one without the other
  # produces the postgres password mismatch trap.
  if [ "$WIPE_VOLUMES" -eq 1 ] && [ "$WIPE_ENV" -eq 0 ]; then
    echo "  [warn] You're wiping volumes but keeping .env. The next deploy will"
    echo "         re-init postgres with .env's POSTGRES_PASSWORD — that's fine,"
    echo "         but if .env was hand-edited or out of sync, consider re-running"
    echo "         ./scripts/dev/configure.sh after to regenerate cleanly."
    echo ""
  fi
  if [ "$WIPE_VOLUMES" -eq 0 ] && [ "$WIPE_ENV" -eq 1 ]; then
    echo "  [warn] You're keeping volumes but wiping .env. The next ./scripts/dev/configure.sh"
    echo "         will generate a NEW .env with a fresh POSTGRES_PASSWORD, but the"
    echo "         volume still has the OLD password baked in — postgres auth WILL fail."
    echo "         Either also wipe volumes, or restore .env from backup before deploying."
    echo ""
    read -r -p "  Continue with this combination anyway? [y/N] " sanity
    case "$sanity" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
    echo ""
  fi

  read -r -p "Proceed? [y/N] " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

WARNINGS=()
warn() { WARNINGS+=("$1"); echo "  [warn] $1"; }

# Compose project name follows Docker's own rules: $COMPOSE_PROJECT_NAME
# wins, otherwise lowercased basename of the working dir.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')}"

# Assemble compose file args from whichever overlays exist on disk. A
# previous deploy may have used the site, dev, or override file, and
# `down -v` without those flags won't see services defined only there.
COMPOSE_FILES=(-f docker-compose.yml)
for overlay in docker-compose.site.yml docker-compose.dev.yml docker-compose.multi.yml docker-compose.override.yml; do
  [ -f "$overlay" ] && COMPOSE_FILES+=(-f "$overlay")
done

echo ""
echo "Project: ${PROJECT_NAME}"
echo "Compose files: ${COMPOSE_FILES[*]}"
echo ""

# Step 1: docker compose down. Add -v only when wiping volumes — without -v
# named volumes are preserved, which matches the WIPE_VOLUMES=0 intent.
DOWN_ARGS=(--remove-orphans --timeout 30)
[ "$WIPE_VOLUMES" -eq 1 ] && DOWN_ARGS+=(-v)

echo "Step 1: docker compose down ${DOWN_ARGS[*]} (with all overlays)..."
if ! docker compose "${COMPOSE_FILES[@]}" down "${DOWN_ARGS[@]}"; then
  warn "compose down exited non-zero — falling through to manual cleanup"
fi
echo ""

# Step 2: force-remove any leftover project containers by label
echo "Step 2: force-remove any leftover project containers by label..."
LEFTOVER_CONTAINERS=$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true)
if [ -n "$LEFTOVER_CONTAINERS" ]; then
  # shellcheck disable=SC2086
  if ! docker rm -f $LEFTOVER_CONTAINERS >/dev/null; then
    warn "failed to remove some containers labeled ${PROJECT_NAME}"
  else
    COUNT=$(echo "$LEFTOVER_CONTAINERS" | wc -l | tr -d ' ')
    echo "  removed ${COUNT} leftover container(s)"
  fi
else
  echo "  none"
fi
echo ""

# Step 3: volumes (only if requested)
if [ "$WIPE_VOLUMES" -eq 1 ]; then
  echo "Step 3: force-remove any leftover project volumes by name..."
  LEFTOVER_VOLUMES=$(docker volume ls -q --filter "name=^${PROJECT_NAME}_" 2>/dev/null || true)
  if [ -n "$LEFTOVER_VOLUMES" ]; then
    while IFS= read -r vol; do
      [ -z "$vol" ] && continue
      if ! docker volume rm -f "$vol" >/dev/null; then
        warn "failed to remove volume ${vol} (a container may still hold it)"
      else
        echo "  removed volume ${vol}"
      fi
    done <<< "$LEFTOVER_VOLUMES"
  else
    echo "  none"
  fi
else
  echo "Step 3: volumes preserved (you opted to keep them). Skipping."
fi
echo ""

# Step 4: project networks
echo "Step 4: force-remove any leftover project networks..."
LEFTOVER_NETWORKS=$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true)
DEFAULT_NETWORK=$(docker network ls -q --filter "name=^${PROJECT_NAME}_default$" 2>/dev/null || true)
ALL_NETWORKS=$(printf '%s\n%s\n' "$LEFTOVER_NETWORKS" "$DEFAULT_NETWORK" | sort -u | grep -v '^$' || true)
if [ -n "$ALL_NETWORKS" ]; then
  while IFS= read -r net; do
    [ -z "$net" ] && continue
    if ! docker network rm "$net" >/dev/null 2>&1; then
      warn "failed to remove network ${net}"
    else
      echo "  removed network ${net}"
    fi
  done <<< "$ALL_NETWORKS"
else
  echo "  none"
fi
echo ""

# Step 5: deploy state and generated config files (each toggled individually)
echo "Step 5: removing selected config / state files..."
NEED_BLANK=0
[ "$WIPE_ENV" -eq 1 ]          && [ -f .env ]                        && rm -f .env                        && echo "  removed .env"                        && NEED_BLANK=1
[ "$WIPE_DEPLOY_STATE" -eq 1 ] && [ -f .deploy-state.json ]          && rm -f .deploy-state.json          && echo "  removed .deploy-state.json"          && NEED_BLANK=1
[ "$WIPE_LOCAL_STATE" -eq 1 ]  && [ -f .local-dev-state.json ]       && rm -f .local-dev-state.json       && echo "  removed .local-dev-state.json"       && NEED_BLANK=1
[ "$WIPE_OVERRIDE" -eq 1 ]     && [ -f docker-compose.override.yml ] && rm -f docker-compose.override.yml && echo "  removed docker-compose.override.yml" && NEED_BLANK=1
[ "$WIPE_CERTS" -eq 1 ]        && [ -d certs ]                       && rm -rf certs/                     && echo "  removed certs/"                      && NEED_BLANK=1
[ "$NEED_BLANK" -eq 0 ] && echo "  (nothing to remove or all preserved)"
echo ""

# Step 6: Docker images (only if requested)
if [ "$WIPE_IMAGES" -eq 1 ]; then
  echo "Step 6: removing Docker images (bigbluebam-*:*) ..."
  IMAGES=$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^bigbluebam-' || true)
  if [ -n "$IMAGES" ]; then
    while IFS= read -r img; do
      [ -z "$img" ] && continue
      if ! docker image rm -f "$img" >/dev/null; then
        warn "failed to remove image ${img}"
      else
        echo "  removed image ${img}"
      fi
    done <<< "$IMAGES"
  else
    echo "  none"
  fi
else
  echo "Step 6: Docker images preserved (you opted to keep them). Skipping."
fi
echo ""

# Verification: only fail on categories the operator asked to wipe.
echo "Verifying clean state..."
REMAINING_CONTAINERS=$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true)
REMAINING_NETWORKS=$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true)
REMAINING_VOLUMES=""
if [ "$WIPE_VOLUMES" -eq 1 ]; then
  REMAINING_VOLUMES=$(docker volume ls -q --filter "name=^${PROJECT_NAME}_" 2>/dev/null || true)
fi

INCOMPLETE=0
if [ -n "$REMAINING_CONTAINERS" ]; then
  echo "  [fail] containers still present:"
  docker ps -a --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format "    {{.Names}}\t{{.Status}}"
  INCOMPLETE=1
fi
if [ -n "$REMAINING_VOLUMES" ]; then
  echo "  [fail] volumes still present (you asked to wipe them):"
  echo "$REMAINING_VOLUMES" | sed 's/^/    /'
  INCOMPLETE=1
fi
if [ -n "$REMAINING_NETWORKS" ]; then
  echo "  [fail] networks still present:"
  echo "$REMAINING_NETWORKS" | sed 's/^/    /'
  INCOMPLETE=1
fi

if [ "$INCOMPLETE" -eq 0 ] && [ "${#WARNINGS[@]}" -eq 0 ]; then
  echo "  [ok] expected items removed; preserved items left intact"
  echo ""
  echo "Decommission complete."
  exit 0
fi

echo ""
if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo "Cleanup completed with ${#WARNINGS[@]} warning(s):"
  for w in "${WARNINGS[@]}"; do
    echo "  - $w"
  done
  echo ""
fi

if [ "$INCOMPLETE" -eq 1 ]; then
  echo "Decommission INCOMPLETE — see [fail] entries above."
  echo "Manual recovery: 'docker rm -f <name>', 'docker volume rm -f <name>',"
  echo "'docker network rm <name>'. Then re-run this script."
  exit 1
fi

echo "Decommission complete (with warnings)."
exit 0
