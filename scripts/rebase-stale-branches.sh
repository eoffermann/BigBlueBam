#!/usr/bin/env bash
#
# rebase-stale-branches.sh — weekly branch hygiene.
#
# Keeps un-merged LOCAL branches from rotting by rebasing them onto the base
# (default origin/stable). It is deliberately conservative:
#
#   - CLEAN rebases are applied; the branch is moved onto the fresh base.
#   - CONFLICTING rebases are ABORTED and the branch is left exactly as it was,
#     then reported for a human to resolve. We never auto-resolve conflicts,
#     because a stale branch usually conflicts precisely where someone else's
#     logic changed, and a blind resolution can silently break it (see
#     pr27-investigate: main shipped a competing version of the same fix).
#   - Every processed branch gets a dated backup ref first.
#   - main and stable are never touched. Nothing is force-pushed. Nothing is
#     pushed at all; landing stays a human decision.
#
# Usage:  scripts/rebase-stale-branches.sh [base-ref]   (default: origin/stable)
# Exit:   0 always (it is a report, not a gate). Summary printed to stdout.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 0

BASE="${1:-origin/stable}"
STAMP="$(git log -1 --format=%cd --date=format:%Y%m%d "$BASE" 2>/dev/null || echo manual)"

git fetch --all --prune --quiet 2>/dev/null || true

# Park any dirty tracked changes so we can switch branches; restore at the end.
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  if git stash push -u -m "rebase-maint autostash ${STAMP}" >/dev/null 2>&1; then STASHED=1; fi
fi

clean=(); conflict=();

for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  case "$b" in
    main|stable) continue ;;
    *-backup-*|*-rebasebak-*) continue ;;   # skip our own backup refs
  esac
  ahead="$(git rev-list --count "${BASE}..${b}" 2>/dev/null || echo 0)"
  [ "${ahead:-0}" -gt 0 ] || continue        # already contained in base: nothing to do

  # Dated safety backup before we touch the branch.
  git branch -f "${b}-rebasebak-${STAMP}" "$b" >/dev/null 2>&1 || true

  if git checkout "$b" >/dev/null 2>&1 && git rebase "$BASE" >/dev/null 2>&1; then
    clean+=("${b}  (${ahead} commits -> now at $(git rev-parse --short HEAD))")
  else
    git rebase --abort >/dev/null 2>&1 || true
    # Branch is untouched (abort restored it), so the backup is redundant: drop it.
    git branch -D "${b}-rebasebak-${STAMP}" >/dev/null 2>&1 || true
    # Name the files that collided, to give the human a head start.
    files="$(git diff --name-only "${BASE}...${b}" 2>/dev/null | head -6 | paste -sd, -)"
    conflict+=("${b}  (${ahead} commits) -- conflicts; touches: ${files:-unknown}")
  fi
done

git checkout "$ORIG_BRANCH" >/dev/null 2>&1 || true
[ "$STASHED" = 1 ] && git stash pop >/dev/null 2>&1 || true

echo "## Branch rebase maintenance vs ${BASE}  ($(git rev-parse --short "$BASE"))"
echo
echo "### Rebased clean (${#clean[@]})"
if [ "${#clean[@]}" -eq 0 ]; then echo "  (none)"; else printf '  - %s\n' "${clean[@]}"; fi
echo
echo "### Needs a human (${#conflict[@]})"
if [ "${#conflict[@]}" -eq 0 ]; then echo "  (none)"; else printf '  - %s\n' "${conflict[@]}"; fi
echo
echo "Backups: <branch>-rebasebak-${STAMP}. main/stable untouched; nothing pushed."
