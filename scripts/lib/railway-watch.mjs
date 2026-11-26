// Railway watch patterns derived from what each Dockerfile actually copies (issue #170).
//
// Railway rebuilds a service only when a changed file matches its watchPatterns. The
// generator used to hard-code `packages/shared/**` as the only workspace package, while
// the Dockerfiles COPY and build packages/storage, permissions, service-health, logging
// and more, so a change to one of those redeployed nothing and the fleet drifted onto
// mixed package versions. The fact "this image contains packages/X" lives in the
// Dockerfile; this module reads it from there, for both the generator and the drift check.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every top-level workspace directory (`packages/<name>` or `apps/<name>`) that a
 * Dockerfile COPYs from the build context, in first-seen order. `COPY --from=<stage>`
 * lines copy between build stages, not from the repo, and are ignored.
 */
export function dockerfileCopiedDirs(dockerfileText) {
  const dirs = [];
  const seen = new Set();
  const text = dockerfileText.replace(/\\\r?\n/g, ' ');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^COPY\s/i.test(line)) continue;
    const args = line.split(/\s+/).slice(1).filter((a) => !a.startsWith('--'));
    if (/^COPY\s.*--from[=\s]/i.test(line)) continue;
    // Every argument but the last is a source.
    for (const src of args.slice(0, -1)) {
      const m = src.replace(/^["']|["']$/g, '').replace(/^\.\//, '').match(/^(packages|apps)\/([A-Za-z0-9._-]+)/);
      if (!m) continue;
      const dir = `${m[1]}/${m[2]}`;
      if (!seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

/** The watch pattern that covers a copied directory. */
export const watchPatternForDir = (dir) => `${dir}/**`;

/**
 * Drift check: every railway/*.json that builds from a Dockerfile must watch every
 * workspace directory that Dockerfile copies. Returns human-readable problems.
 */
export function railwayWatchProblems(root) {
  const problems = [];
  const dir = join(root, 'railway');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const cfg = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const dockerfile = cfg?.build?.dockerfilePath;
    if (!dockerfile) continue;
    const path = join(root, dockerfile);
    if (!existsSync(path)) {
      problems.push(`railway/${f}: dockerfilePath ${dockerfile} does not exist`);
      continue;
    }
    const watch = new Set(cfg.build.watchPatterns ?? []);
    for (const copied of dockerfileCopiedDirs(readFileSync(path, 'utf8'))) {
      if (!watch.has(watchPatternForDir(copied))) {
        problems.push(
          `railway/${f}: ${dockerfile} copies ${copied}/ but watchPatterns lacks '${watchPatternForDir(copied)}' ` +
            '(re-run node scripts/gen-railway-configs.mjs)',
        );
      }
    }
  }
  return problems;
}
