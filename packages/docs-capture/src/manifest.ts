/**
 * Manifest writer.
 *
 * Records one entry per captured image — recipe id, app, environment, theme,
 * viewport, captured dimensions, the frozen timestamp used, and the git SHA of
 * the suite under capture — to `manifest.json` at the shared screenshots root.
 * This gives traceability and the hook for wiring captures into the docs and
 * marketing-site asset pipelines, and (with the determinism controls) the basis
 * for visual-regression diffing later.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ManifestEntry {
  id: string;
  app: string;
  /** Path relative to the shared screenshots root. */
  file: string;
  demonstrates: string;
  environment: string;
  theme: 'light' | 'dark';
  viewport: string;
  deviceScaleFactor: number;
  width: number;
  height: number;
  sha256: string;
  frozenTime: string;
  gitSha: string;
  capturedAt: string;
}

/** Resolve the current git SHA once (short-circuits to env or "unknown"). */
export function resolveGitSha(): string {
  if (process.env.SHOTS_GIT_SHA) return process.env.SHOTS_GIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Accumulates manifest entries during a run and writes them merged with any
 * existing manifest (so a partial run — one app — updates only its rows).
 */
export class ManifestWriter {
  private entries: ManifestEntry[] = [];
  constructor(private readonly rootDir: string) {}

  add(entry: ManifestEntry): void {
    this.entries.push(entry);
  }

  get manifestPath(): string {
    return path.join(this.rootDir, 'manifest.json');
  }

  /**
   * Merge this run's entries into the on-disk manifest, keyed by
   * `${app}/${id}/${theme}/${viewport}` so re-running a subset replaces only
   * those rows. Returns the full merged list.
   */
  flush(): ManifestEntry[] {
    const key = (e: ManifestEntry) => `${e.app}/${e.id}/${e.theme}/${e.viewport}`;
    const merged = new Map<string, ManifestEntry>();

    if (fs.existsSync(this.manifestPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as ManifestEntry[];
        for (const e of prior) merged.set(key(e), e);
      } catch {
        /* corrupt/old manifest — start fresh */
      }
    }
    for (const e of this.entries) merged.set(key(e), e);

    const list = [...merged.values()].sort(
      (a, b) => a.app.localeCompare(b.app) || a.id.localeCompare(b.id) || a.theme.localeCompare(b.theme),
    );
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(list, null, 2)}\n`);
    return list;
  }
}
