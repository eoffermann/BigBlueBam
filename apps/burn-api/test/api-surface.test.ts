import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BURN_FLOORED_SURFACES } from '../src/lib/redact-financial-fields.js';

const SRC = join(__dirname, '..', 'src');
const ROUTES = join(SRC, 'routes');

function routeFiles(): string[] {
  return readdirSync(ROUTES).filter((f) => f.endsWith('.routes.ts'));
}
function routeSource(file: string): string {
  return readFileSync(join(ROUTES, file), 'utf8');
}

/**
 * Strip comments before asserting on source.
 *
 * Every file these assertions touch DOCUMENTS the forbidden identifier at length -- that is
 * the entire point of those comments. A naive substring assertion therefore fails on the
 * explanation rather than on the offence, and the obvious way to make it pass is to delete
 * the explanation, which is exactly backwards. So the assertions run against code with
 * comments removed, and the prose survives.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

function allSrcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSrcFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════
   Spec 12.1, "Security" and section 6. The surveillance-join enumeration, the search
   oracle, the two-gate surfaces, and the flooring identity.
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe('every member-reachable money surface passes through the ONE serializer (R2-S3)', () => {
  // Enumerated BY NAME rather than spot-checked, because round 1 shipped the hole exactly
  // by flooring /v1/work-items and leaving /v1/attributions and /v1/unscoped, which project
  // the same amounts through the same work-item join.
  const MONEY_ROUTES: Array<{ file: string; path: string }> = [
    { file: 'ledger.routes.ts', path: '/work-items' },
    { file: 'ledger.routes.ts', path: '/attributions' },
    { file: 'ledger.routes.ts', path: '/unscoped' },
    { file: 'ledger.routes.ts', path: '/queue-health' },
    { file: 'variances.routes.ts', path: '/variances' },
    { file: 'variances.routes.ts', path: '/change-orders/:id' },
    { file: 'engagements.routes.ts', path: '/engagements' },
    { file: 'engagements.routes.ts', path: '/engagements/:id/burndown' },
    { file: 'financials.routes.ts', path: '/financials' },
    { file: 'deliverables.routes.ts', path: '/deliverables' },
  ];

  for (const { file, path } of MONEY_ROUTES) {
    it(`${path} calls redactFinancialFields`, () => {
      const source = routeSource(file);
      expect(source).toContain(`'${path}'`);
      expect(source).toContain('redactFinancialFields');
    });
  }

  it('the eight floored surfaces are still enumerated as data, so a ninth needs a fixture', () => {
    expect([...BURN_FLOORED_SURFACES]).toEqual([
      '/v1/work-items',
      '/v1/attributions',
      '/v1/unscoped',
      '/v1/queue-health',
      '/v1/change-orders/:id',
      'burn_variances.detail',
      'mcp.tool_payload',
      'csv.export',
    ]);
  });
});

describe('fastify.canResolve appears nowhere in a flooring decision path (R3-S1)', () => {
  it('is absent from every code line in the src tree', () => {
    // packages/permissions/src/index.ts:307-319 is a hardcoded `return true`. The only
    // in-tree precedent for satellite field flooring calls it and therefore floors NOTHING.
    // Copying that precedent here would ship cost_amount to every project member at a 100
    // percent rate, and for one bam.time_entry row cost_amount / (minutes / 60) IS that
    // person's hourly rate to the cent.
    const offenders = allSrcFiles()
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes('canResolve'))
      .map((f) => f.replace(SRC, ''));
    expect(offenders).toEqual([]);
  });

  it('but the prohibition is still DOCUMENTED, so the next reader knows why', () => {
    // The inverse assertion. If someone "fixes" the test above by deleting the comments,
    // this one fails and says so.
    const capsDoc = readFileSync(join(SRC, 'lib', 'viewer-caps.ts'), 'utf8');
    expect(capsDoc).toContain('canResolve');
    expect(capsDoc).toMatch(/FORBIDDEN|hardcoded/i);
  });
});

describe('the search oracle is closed (R3-S4)', () => {
  const code = stripComments(
    readFileSync(join(SRC, 'services', 'deliverables.service.ts'), 'utf8'),
  );

  it('search_tsv appears in exactly one code line, the read_all branch', () => {
    const tsvLines = code.split('\n').filter((line) => line.includes('search_tsv'));
    expect(tsvLines.length).toBe(1);
    expect(tsvLines[0]).toContain('plainto_tsquery');
  });

  it('the non-read_all branch matches title only', () => {
    const fn = code.slice(
      code.indexOf('function searchPredicate'),
      code.indexOf('export async function listDeliverables'),
    );
    // The member branch is everything from the `!canReadAll` guard up to the FINAL return,
    // which is the read_all fallthrough. Slicing at `plainto_tsquery` would not work: the
    // read_all line reads `${...search_tsv} @@ plainto_tsquery(...)`, so `search_tsv` sits
    // to the left of the split point and would be counted against the member branch.
    const memberBranch = fn.slice(fn.indexOf('if (!canReadAll)'), fn.lastIndexOf('return sql'));
    expect(memberBranch).toContain('burnDeliverables.title');
    expect(memberBranch).not.toContain('search_tsv');
    expect(memberBranch).not.toContain('description');
  });

  it('no route sorts, ranks, or highlights on a floored column', () => {
    for (const file of routeFiles()) {
      const src = stripComments(routeSource(file));
      expect(src, `${file} must not rank on search_tsv`).not.toMatch(
        /ts_rank|ts_headline|search_tsv/,
      );
    }
  });
});

describe('the two-gate surfaces carry BOTH the permission and the in-route role guard (2.4 point 1)', () => {
  // A permission-resolver outage returns 'unknown'. burn-api runs onUnknown:'deny', but
  // these surfaces carry per-person compensation and firm-wide profitability, so they get a
  // second, independent guard that reads the org role directly off request.user.
  const TWO_GATE: Array<{ file: string; anchor: string; label: string; permission: string }> = [
    {
      file: 'financials.routes.ts',
      anchor: "'/financials/accounts'",
      label: '/financials/accounts',
      permission: 'burn.financials.read_all',
    },
    {
      file: 'financials.routes.ts',
      anchor: "'/financials/export'",
      label: '/financials/export',
      permission: 'burn.financials.read_all',
    },
    {
      file: 'financials.routes.ts',
      anchor: "'/cost-rates'",
      label: '/cost-rates',
      permission: 'burn.costrate.read',
    },
    {
      // `/settings` is registered twice (GET reads, PATCH writes) and only the PATCH carries
      // the write permission, so anchor on the verb rather than on the path alone.
      file: 'settings.routes.ts',
      anchor: "fastify.patch(\n    '/settings'",
      label: 'PATCH /settings',
      permission: 'burn.settings.write',
    },
  ];

  for (const { file, anchor, label, permission } of TWO_GATE) {
    it(`${label} gates on ${permission} AND requireOrgAdmin`, () => {
      const source = routeSource(file);
      const idx = source.indexOf(anchor);
      expect(idx, `${label} not found in ${file}`).toBeGreaterThan(-1);
      const window = source.slice(idx, idx + 600);
      expect(window).toContain(permission);
      expect(window).toContain('requireOrgAdmin');
    });
  }

  it('every cost-rate verb carries the role guard, not just the read', () => {
    const source = routeSource('financials.routes.ts');
    const chunks = source.split("'/cost-rates").slice(1);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(chunk.slice(0, 300)).toContain('requireOrgAdmin');
    }
  });
});

describe('project scoping is Burn-specific, not a Bulwark port (R2-S6)', () => {
  const source = readFileSync(join(SRC, 'lib', 'project-scope.ts'), 'utf8');
  const code = stripComments(source);

  it('engagement reachability runs through burn_engagement_projects', () => {
    expect(code).toContain('burnEngagementProjects');
    expect(code).toContain('projectMemberships');
  });

  it('there is NO null/empty fallback that would open a zero-project chain', () => {
    // The Bulwark helper treats a null project as "every org member passes". Applied to a
    // Burn chain with no linked projects -- which spec 3.1 defines as read_all-only -- that
    // would make the least-scoped chains the most widely readable ones.
    const rowScope = code.slice(code.indexOf('export function rowProjectScopePredicate'));
    expect(rowScope).toContain('sql`false`');
    expect(rowScope.slice(0, rowScope.indexOf('export function orgAndEngagementScope'))).not.toContain(
      'isNull(',
    );

    const rowGuard = code.slice(code.indexOf('export async function canAccessRowProject'));
    expect(rowGuard).toContain('if (!projectId) return false;');
  });

  it('the engagement predicate has no admin-independent escape hatch', () => {
    const fn = code.slice(
      code.indexOf('export function engagementScopePredicate'),
      code.indexOf('export function rowProjectScopePredicate'),
    );
    expect(fn).toContain('if (isAdminViewer(viewer)) return undefined;');
    expect(fn).toContain('EXISTS');
  });
});

describe('internal routes fail CLOSED on an empty secret (2.4 point 16)', () => {
  it('rejects unconditionally before any timing-safe compare', () => {
    const code = stripComments(readFileSync(join(SRC, 'lib', 'internal-secret.ts'), 'utf8'));
    const guard = code.slice(code.indexOf('export function requireInternalSecret'));
    const emptyCheckIdx = guard.indexOf('configured.length === 0');
    const compareIdx = guard.indexOf('timingSafeEqual');
    expect(emptyCheckIdx).toBeGreaterThan(-1);
    expect(compareIdx).toBeGreaterThan(-1);
    // The empty-secret rejection must come FIRST: timingSafeEqual('', '') is true.
    expect(emptyCheckIdx).toBeLessThan(compareIdx);
  });

  it('every /internal route calls the guard', () => {
    const source = routeSource('internal.routes.ts');
    const internalRoutes = source.match(/fastify\.post\('\/internal[^']*'/g) ?? [];
    // M6 added the engine-invocation routes (extraction, attribute-batch, the SQL sweeps,
    // proposal-decided, ...) alongside the original precheck / outcome / events trio.
    expect(internalRoutes.length).toBe(15);
    // Every internal route guards, either INLINE via requireInternalSecret(request, reply) or by
    // delegating to the shared engineRoute helper (which calls requireInternalSecret first). The
    // helper contributes one requireInternalSecret occurrence that is NOT a per-route guard, so it
    // is subtracted before comparing against the route count.
    const inlineGuards = source.match(/requireInternalSecret\(request, reply\)/g) ?? [];
    const engineDelegations = source.match(/engineRoute\(request, reply/g) ?? [];
    expect(inlineGuards.length - 1 + engineDelegations.length).toBe(internalRoutes.length);
    // The shared helper must itself guard, or the delegating routes would be unauthenticated.
    expect(source).toMatch(/async function engineRoute[\s\S]{0,400}requireInternalSecret\(request, reply\)/);
  });
});

describe('realtime frames carry refs and coarse bands only (6.2)', () => {
  const source = readFileSync(join(SRC, 'lib', 'realtime.ts'), 'utf8');
  const code = stripComments(source);

  it('validates every frame against the shared schema before publishing', () => {
    expect(code).toContain('burnWsFrameSchema.safeParse(frame)');
    // A malformed frame is dropped rather than published: the schema is the only thing
    // between "coarse band" and "dollar amount".
    expect(code).toMatch(/if \(!parsed\.success\)[\s\S]{0,200}return;/);
  });

  it('has no proj:none room, so a zero-project chain reaches admins only', () => {
    // Bulwark has one; Burn deliberately does not, for the same D4 reason as the predicate.
    expect(code).not.toContain('proj:none');
    expect(code).toContain('burn:org:${orgId}:admin');
  });

  it('the publisher never throws into the write path that produced the frame', () => {
    const publish = code.slice(code.indexOf('async function publishToRoom'));
    expect(publish).toMatch(/try \{[\s\S]{0,300}\} catch \{/);
  });
});
