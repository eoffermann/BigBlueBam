// Branch-selection prompt shared by all deploy platforms.
//
// BigBlueBam uses two long-running branches:
//
//   - `stable`  — the production branch. Every commit here has been
//                 validated on `main` and, where possible, exercised in a
//                 real deployment. This is the default for deploys.
//   - `main`    — the bleeding-edge integration branch. New features and
//                 fixes land here first. Deploying from `main` gives you
//                 the latest code at the cost of higher instability risk.
//
// This module exports `chooseDeployBranch()`, which fetches origin, verifies
// that both branches exist, and prompts the operator with a select menu
// defaulting to `stable`. Used by both the Docker Compose and Railway
// platform adapters so the experience is uniform.
//
// Zero dependencies beyond node:child_process + the shared prompt helpers.

import { execSync } from 'node:child_process';
import { select } from './prompt.mjs';
import { dim, yellow, check } from './colors.mjs';
import { loadDeploySettings } from './db-settings.mjs';

/**
 * Return the list of branches that exist on origin (without the `origin/`
 * prefix). Silent on failure — returns an empty array if git isn't available
 * or the remote is unreachable.
 */
function listOriginBranches() {
  try {
    const out = execSync('git ls-remote --heads origin', {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15000,
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // Each line looks like:   <sha>\trefs/heads/<branch-name>
        const idx = line.lastIndexOf('refs/heads/');
        return idx >= 0 ? line.slice(idx + 'refs/heads/'.length) : null;
      })
      .filter((b) => b !== null);
  } catch {
    return [];
  }
}

/**
 * Detect the local branch the user is currently on. Returns null if the
 * check fails or the user is in a detached HEAD state.
 */
function detectCurrentBranch() {
  try {
    const b = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (b && b !== 'HEAD') return b;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Prompt the operator to choose the deploy branch.
 *
 * Behavior:
 *   1. Fetch origin so local refs are fresh.
 *   2. List origin branches.
 *   3. Build a menu:
 *        - "stable  (recommended — validated on main first)"
 *        - "main    (bleeding-edge — latest features, may be unstable)"
 *        - "<current local branch>   (custom)"  — only shown if the user is
 *          currently on a branch that isn't `stable` or `main`.
 *   4. Default to `stable`. Return the chosen branch name.
 *
 * If origin doesn't have a `stable` branch (e.g., an early fork), we warn and
 * fall back to `main`. If neither branch exists, we throw.
 *
 * @param {object} [options]
 * @param {string} [options.previous] - Branch selected in a prior run
 *   (from .deploy-state.json). If present, the prompt offers to reuse it.
 * @returns {Promise<string>} The chosen branch name.
 */
export async function chooseDeployBranch({ previous } = {}) {
  // Refresh origin so the branch list is current.
  try {
    execSync('git fetch origin --prune', { stdio: 'pipe', timeout: 20000 });
  } catch {
    console.log(dim('  Could not fetch from origin (offline?) — using cached branch list.'));
  }

  const branches = new Set(listOriginBranches());
  const hasStable = branches.has('stable');
  const hasMain = branches.has('main');

  if (!hasStable && !hasMain) {
    throw new Error(
      'Neither `stable` nor `main` exists on origin. Push one of those branches before deploying.',
    );
  }

  if (!hasStable) {
    console.log(yellow("  `stable` doesn't exist on origin yet — defaulting to `main`."));
    console.log(dim('  Create a `stable` branch from a validated commit to enable the safer default.'));
    return 'main';
  }

  // Consult the running stack's SuperUser-managed deploy settings, if
  // any. This lets the operator pin the default deploy branch via the
  // SuperUser UI without modifying the script. If the stack is down,
  // postgres unreachable, or the row simply doesn't exist, settings is
  // null / null-valued and we fall back to the hardcoded `stable`
  // default. See docs/plans/deploy-settings-contract.md.
  let settings = null;
  try {
    settings = await loadDeploySettings();
  } catch {
    settings = null;
  }
  let suDefaultBranch = null;
  if (settings?.deploy_branch && branches.has(settings.deploy_branch)) {
    suDefaultBranch = settings.deploy_branch;
  } else if (settings?.deploy_branch) {
    console.log(
      yellow(
        `  SuperUser-configured branch "${settings.deploy_branch}" does not exist on origin — ignoring.`,
      ),
    );
  }

  // The hardcoded fallback default is `stable`. The SU override wins if
  // present-and-valid, otherwise stable.
  const defaultBranch = suDefaultBranch ?? 'stable';

  // Build the choice menu, with the resolved default first so the
  // select helper picks it up as the [enter]-to-accept option.
  const options = [];
  if (defaultBranch === 'stable') {
    options.push({
      label: 'stable',
      value: 'stable',
      description: 'Recommended — production branch, validated on main first',
    });
    if (hasMain) {
      options.push({
        label: 'main',
        value: 'main',
        description: 'Bleeding-edge — latest features, may be unstable',
      });
    }
  } else if (defaultBranch === 'main') {
    // SU pinned `main` as default — still show stable as an option.
    options.push({
      label: 'main',
      value: 'main',
      description: 'Bleeding-edge — latest features, may be unstable',
    });
    options.push({
      label: 'stable',
      value: 'stable',
      description: 'Recommended — production branch, validated on main first',
    });
  } else {
    // SU pinned an arbitrary branch (e.g. a release line). Show it
    // first as the default, then stable, then main.
    options.push({
      label: defaultBranch,
      value: defaultBranch,
      description: 'SuperUser-configured deploy branch',
    });
    options.push({
      label: 'stable',
      value: 'stable',
      description: 'Recommended — production branch, validated on main first',
    });
    if (hasMain) {
      options.push({
        label: 'main',
        value: 'main',
        description: 'Bleeding-edge — latest features, may be unstable',
      });
    }
  }

  const current = detectCurrentBranch();
  if (
    current &&
    current !== 'stable' &&
    current !== 'main' &&
    current !== defaultBranch
  ) {
    options.push({
      label: current,
      value: current,
      description: 'Your current local branch (advanced)',
    });
  }

  // Surface the SU override above the prompt so the operator
  // understands why the default may have changed.
  if (suDefaultBranch) {
    console.log(dim(`  (using SuperUser-configured default: ${suDefaultBranch})`));
  }

  // If a previous choice was saved, nudge the user to reuse it.
  if (previous && options.some((o) => o.value === previous)) {
    console.log(dim(`  Last deploy used branch ${previous}.`));
  }

  const choice = await select(
    'Which branch do you want to deploy?',
    options,
  );

  console.log(`  ${check} Deploying branch: ${choice}`);
  console.log('');
  return choice;
}
