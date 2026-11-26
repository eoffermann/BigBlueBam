import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Every bastion-api route runs requireAuth and requireCan with an identifier that exists in the
// generated permission manifest (spec 5.5 is the single source; the manifest is generated from
// it at M2). The vouching routes (spec 2.8) also require a session and refuse impersonation.
// Static scan of the route files, so a new route without a gate fails here.

const ROOT = join(__dirname, '../../..');
const ROUTES = join(__dirname, '../src/routes');
const manifest = JSON.parse(readFileSync(join(ROOT, 'docs/permissions-action-manifest.json'), 'utf8')) as unknown;
const MANIFEST_IDS = new Set(
  [...JSON.stringify(manifest).matchAll(/"(bastion\.[a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]!),
);

interface RouteDecl {
  file: string;
  method: string;
  path: string;
  preHandler: string;
}

// Service-to-service routes (spec 5.1 rows 105-106) authenticate with the internal secret, not a
// user, and nginx denies /bastion/api/v1/internal/ from outside. Checked separately below.
const INTERNAL_FILE = 'internal.routes.ts';
// The machine push (spec 5.1 row 48) authenticates with its own per-feed key, not a user. Checked
// separately below.
const FEED_INGEST_FILE = 'feed-ingest.routes.ts';

function routes(): RouteDecl[] {
  const out: RouteDecl[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.routes.ts') && f !== INTERNAL_FILE && f !== FEED_INGEST_FILE)) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    const re = /fastify\.(get|post|patch|put|delete)\(\s*'([^']+)',\s*\{\s*preHandler:\s*\[([^\]]*)\]/g;
    for (const m of src.matchAll(re)) out.push({ file, method: m[1]!.toUpperCase(), path: m[2]!, preHandler: m[3]! });
    const declared = [...src.matchAll(/fastify\.(get|post|patch|put|delete)\(/g)].length;
    expect(out.filter((r) => r.file === file).length, `${file}: every route declares a preHandler array`).toBe(declared);
  }
  return out;
}

const VOUCHING = new Set(['POST /assertions/:id/confirm', 'POST /assertions/:id/reject']);
// Integrity acts (spec 3.4) and the M5 vouching routes (spec 2.8, #136): session-only and never
// impersonated, before requireCan. A person attests to an upload, accepts it, or redacts.
const INTEGRITY: Record<string, string> = {
  'POST /ledger/restores/:id/acknowledge': "can('bastion.ledger.acknowledge_restore')",
  'POST /manual-evidence': "can('bastion.evidence.upload')",
  'POST /manual-evidence/:id/supersede': "can('bastion.evidence.upload')",
  'POST /manual-evidence/:id/links/:assertion_id/review': "can('bastion.evidence.review')",
  'POST /personal-data/:id/redact': "can('bastion.evidence.redact')",
};

// Routes that must NOT require a session: everything an agent may do through an API key
// (decision #196). A session gate here would silently break the MCP tool.
const AGENT_REACHABLE = [
  'GET /manual-evidence',
  'GET /manual-evidence/:id',
  'POST /manual-evidence/:id/links',
  'DELETE /manual-evidence/:id/links/:assertion_id',
  'POST /manual-evidence/:id/withdraw',
  'POST /manual-evidence/:id/check-again',
  'GET /feeds',
  'POST /feeds',
  'PATCH /feeds/:id',
  'GET /feeds/:id/records',
  'GET /coverage',
  'GET /summary',
];

describe('bastion-api route gates', () => {
  const all = routes();

  it('found the M3 routes', () => {
    expect(all.length).toBeGreaterThanOrEqual(24);
  });

  for (const r of all) {
    it(`${r.method} ${r.path} runs requireAuth and a catalogued requireCan`, () => {
      expect(r.preHandler).toMatch(/\brequireAuth\b/);
      const id = r.preHandler.match(/can\('([^']+)'\)/)?.[1];
      expect(id, 'requireCan id').toBeDefined();
      expect(MANIFEST_IDS.has(id!), `${id} is in docs/permissions-action-manifest.json`).toBe(true);
    });
  }

  it('the vouching routes require a session and refuse impersonation, before requireCan', () => {
    for (const r of all.filter((x) => VOUCHING.has(`${x.method} ${x.path}`))) {
      const order = ['requireAuth', 'requireSession', 'rejectWhenImpersonating', "can('bastion.assertion.confirm')"].map((s) =>
        r.preHandler.indexOf(s),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
    expect(all.filter((x) => VOUCHING.has(`${x.method} ${x.path}`))).toHaveLength(VOUCHING.size);
  });

  it('restore acknowledgement requires a session and refuses impersonation, before requireCan', () => {
    for (const [route, gate] of Object.entries(INTEGRITY)) {
      const r = all.find((x) => `${x.method} ${x.path}` === route);
      expect(r, route).toBeDefined();
      const order = ['requireAuth', 'requireSession', 'rejectWhenImpersonating', gate].map((s) => r!.preHandler.indexOf(s));
      expect(order.every((i) => i >= 0), route).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('M5 routes an agent may call carry no session gate', () => {
    for (const route of AGENT_REACHABLE) {
      const r = all.find((x) => `${x.method} ${x.path}` === route);
      expect(r, route).toBeDefined();
      expect(r!.preHandler, route).not.toMatch(/requireSession|rejectWhenImpersonating/);
    }
  });

  it('the feed push authenticates with its own key, a byte cap, and no user gate', () => {
    const src = readFileSync(join(ROUTES, FEED_INGEST_FILE), 'utf8');
    const handlers = [...src.matchAll(/fastify\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(handlers).toEqual(['POST /feeds/:feed_key/records']);
    expect(src).toContain('bodyLimit: BASTION_FEED_MAX_BATCH_BYTES');
    expect(src).toContain('authenticateFeedPush(');
    expect(src.indexOf('authenticateFeedPush(')).toBeLessThan(src.indexOf('bastionFeedBatchSchema.safeParse'));
    expect(src).not.toMatch(/import[^;]*requireAuth|requireCan\(/);
  });

  it('every internal route checks the internal secret first', () => {
    const src = readFileSync(join(ROUTES, INTERNAL_FILE), 'utf8');
    const handlers = [...src.matchAll(/fastify\.(get|post|patch|put|delete)\(\s*'(\/internal\/[^']+)'/g)].map((m) => m[2]);
    expect(handlers.sort()).toEqual(['/internal/engines/:name', '/internal/events']);
    const blocks = src.split(/fastify\.(?:get|post|patch|put|delete)\(/).slice(1);
    for (const b of blocks) expect(b.indexOf('requireInternalSecret(request, reply)')).toBeGreaterThan(-1);
  });
});
