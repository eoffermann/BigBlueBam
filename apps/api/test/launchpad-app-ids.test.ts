import { describe, it, expect, vi } from 'vitest';
import * as shared from '@bigbluebam/shared';

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    LOG_LEVEL: 'silent',
  },
}));
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LAUNCHPAD_APP_IDS,
  LAUNCHPAD_CATALOG,
  REDIRECT_MAP,
  ROOT_REDIRECT_VALUES,
} from '../src/routes/system-settings.routes.js';

/**
 * Issue #144: the api and the MCP tools share ONE Launchpad app-id list from
 * @bigbluebam/shared. The api re-exports it (the docs/nginx scripts still parse
 * LAUNCHPAD_CATALOG from system-settings.routes.ts), so the catalog rows must
 * cover exactly those ids in the same order.
 */
describe('Launchpad app ids (issue #144)', () => {
  it('the api re-exports the shared const itself, not a copy', () => {
    expect(LAUNCHPAD_APP_IDS).toBe(shared.LAUNCHPAD_APP_IDS);
  });

  it('LAUNCHPAD_CATALOG lists exactly the shared ids, in order', () => {
    expect(LAUNCHPAD_CATALOG.map((e) => e.id)).toEqual([...shared.LAUNCHPAD_APP_IDS]);
  });
});

/**
 * Issue #158: the Bam admin Launchpad editors hand-coded 14 apps, so saving from
 * them silently dropped every newer app, and the root-redirect picker and the
 * Bureau URL classifier kept their own short lists too. All of them now derive
 * from the shared constants; these checks fail when a hand-kept roster returns.
 */
describe('no hand-kept Launchpad app rosters (issue #158)', () => {
  it('every root_redirect value resolves to a path, and every app is a valid target', () => {
    expect(ROOT_REDIRECT_VALUES).toBe(shared.ROOT_REDIRECT_VALUES);
    expect([...ROOT_REDIRECT_VALUES]).toEqual(['site', ...shared.LAUNCHPAD_APP_IDS]);
    for (const v of ROOT_REDIRECT_VALUES) {
      if (v === 'site') expect(REDIRECT_MAP[v]).toBeNull();
      else expect(REDIRECT_MAP[v], v).toBe(LAUNCHPAD_CATALOG.find((e) => e.id === v)!.path);
    }
  });

  it('launchpadAppFromUrl classifies every app path', () => {
    for (const e of LAUNCHPAD_CATALOG) {
      expect(shared.launchpadAppFromUrl(`https://x.test${e.path}some/page`), e.id).toBe(e.id === 'b3' ? 'bam' : e.id);
    }
    expect(shared.launchpadAppFromUrl('https://x.test/files/a')).toBeNull();
  });

  it('no source file in apps/frontend or apps/bureau-api hand-codes a list of Launchpad app ids', () => {
    // Deliberate SUBSETS, not app rosters. A new entry needs a reason.
    const ALLOWED: Record<string, string> = {
      'bureau-api/src/routes/livekit.routes.ts': 'SURFACE_APPS: the huddle-capable surfaces, a curated subset',
      'bureau-api/src/routes/ring.routes.ts': 'SURFACE_APPS: the ring-capable surfaces, a curated subset',
    };
    const root = resolve(__dirname, '..', '..');
    const ids = new Set<string>(shared.LAUNCHPAD_APP_IDS);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== 'node_modules' && ent.name !== 'dist') walk(p);
        } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
          const text = readFileSync(p, 'utf8');
          // An array literal naming 8+ Launchpad app ids as quoted strings or `id:` fields.
          for (const m of text.matchAll(/\[[^\[\]]{0,4000}\]/g)) {
            const named = new Set(
              [...m[0].matchAll(/(?:id:\s*)?['"]([a-z0-9]+)['"]/g)].map((x) => x[1]!).filter((x) => ids.has(x)),
            );
            const rel = p.slice(root.length + 1).replace(/\\/g, '/');
            if (named.size >= 8 && !(rel in ALLOWED)) offenders.push(`${rel} (${named.size} app ids)`);
          }
        }
      }
    };
    for (const app of ['frontend', 'bureau-api']) walk(join(root, app, 'src'));
    expect(offenders).toEqual([]);
  });
});
