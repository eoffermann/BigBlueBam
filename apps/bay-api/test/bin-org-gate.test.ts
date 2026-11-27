import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Bay links Bay assets to Bin assets by a client-supplied bin_asset_id and
// streams the Bin bytes itself on the anonymous public review surface. Both
// ends must be held to one org: the write (createAsset / createVersion only
// accept a Bin asset in the caller's org) and the read (bin-media only serves
// a Bin asset in the review link's org).

const ORG = '00000000-0000-4000-8000-0000000000aa';
const OWN_BIN = '00000000-0000-4000-8000-0000000000b1';
const FOREIGN_BIN = '00000000-0000-4000-8000-0000000000f1';

const dialect = new PgDialect();
const { executed, inserts } = vi.hoisted(() => ({ executed: [] as Array<{ sql: string; params: unknown[] }>, inserts: [] as unknown[] }));

vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('@bigbluebam/storage', () => ({
  requireEnvBootstrapDriver: () => ({ stat: async () => ({ size: 10 }), getStream: async () => ({}) }),
}));
vi.mock('../src/db/index.js', () => ({
  db: {
    execute: async (query: SQL) => {
      const q = dialect.sqlToQuery(query);
      executed.push(q);
      if (q.sql.includes('FROM bin_assets') && q.sql.includes('org_id')) {
        const [id, org] = q.params as string[];
        if (id === OWN_BIN && org === ORG) {
          return [{ ok: 1, object_key: 'k', content_type: 'video/mp4', scan_status: 'clean' }];
        }
        return [];
      }
      // Unscoped bin_assets read (the pre-fix shape): any id resolves.
      if (q.sql.includes('FROM bin_assets')) return [{ object_key: 'k', content_type: 'video/mp4', scan_status: 'clean' }];
      return [];
    },
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.leftJoin = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = async () => [{ id: 'asset-1', org_id: ORG, n: 0 }];
      return chain;
    },
    insert: () => ({
      values: (v: unknown) => {
        inserts.push(v);
        return { returning: async () => [{ id: 'new', ...(v as object) }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  },
}));

import { statBinMedia } from '../src/lib/bin-media.js';
import { createAsset } from '../src/services/asset.service.js';
import { createVersion } from '../src/services/version.service.js';

beforeEach(() => {
  executed.length = 0;
  inserts.length = 0;
});

describe('Bay to Bin org gate', () => {
  it('serves a Bin asset only within the given org', async () => {
    expect(await statBinMedia(OWN_BIN, ORG, 'original')).toMatchObject({ total: 10 });
    expect(await statBinMedia(FOREIGN_BIN, ORG, 'original')).toBeNull();
    expect(executed.every((q) => q.params.includes(ORG))).toBe(true);
  });

  it('refuses to create a Bay asset over another org\'s Bin asset', async () => {
    await expect(
      createAsset({ name: 'x', media_kind: 'video', bin_asset_id: FOREIGN_BIN }, ORG, 'u1'),
    ).rejects.toThrow(/Bin asset not found/);
    expect(inserts).toEqual([]);
  });

  it('creates a Bay asset over its own org\'s Bin asset', async () => {
    await createAsset({ name: 'x', media_kind: 'video', bin_asset_id: OWN_BIN }, ORG, 'u1');
    expect(inserts).toHaveLength(1);
  });

  it('refuses a version that points at another org\'s Bin asset', async () => {
    await expect(createVersion('asset-1', ORG, 'u1', { bin_asset_id: FOREIGN_BIN })).rejects.toThrow(
      /Bin asset not found/,
    );
    expect(inserts).toEqual([]);
  });
});
