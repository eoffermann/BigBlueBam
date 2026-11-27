import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// M10 parity cross-walk (WIP doc M10; orchestrator decision on #196). One fact, three places:
// the bastion-api route files are the source; every route an API key may call has a client
// method in clients/bastion-client.ts that a bastion_* tool uses, every other route is one of the
// sanctioned skips below, and docs/reference/mcp-endpoint-mapping.md has a row for each that says
// the same thing. A route added without a tool or a skip, a stale skip, an orphan client method,
// or a surface-map row that disagrees fails here.

const ROOT = join(__dirname, '..', '..', '..');
const ROUTES_DIR = join(ROOT, 'apps', 'bastion-api', 'src', 'routes');
const CLIENT = readFileSync(join(__dirname, '..', 'src', 'clients', 'bastion-client.ts'), 'utf8');
const TOOLS = readFileSync(join(__dirname, '..', 'src', 'tools', 'bastion-tools.ts'), 'utf8');
const SEARCH_TOOLS = readFileSync(join(__dirname, '..', 'src', 'tools', 'search-tools.ts'), 'utf8');
const MAP = readFileSync(join(ROOT, 'docs', 'reference', 'mcp-endpoint-mapping.md'), 'utf8');

type Category =
  | 'session'
  | 'binary'
  | 'credentials'
  | 'public-inbound'
  | 'internal';

// Every bastion-api route with no client method, and why. The categories are the sanctioned
// ones; "session" is auth: session required (spec 2.8, #136) for vouching acts.
const SKIPS: Record<string, Category> = {
  'POST /assertions/:id/confirm': 'session',
  'POST /assertions/:id/reject': 'session',
  'POST /ledger/restores/:id/acknowledge': 'session',
  'POST /manual-evidence': 'session',
  'POST /manual-evidence/:id/links/:assertion_id/review': 'session',
  'POST /manual-evidence/:id/withdraw': 'session',
  'POST /manual-evidence/:id/supersede': 'session',
  'POST /personal-data/:id/redact': 'session',
  'POST /fix-drafts/:id/decide': 'session',
  'POST /exceptions/:id/decide': 'session',
  'POST /policies/:id/attest': 'session',
  'POST /questionnaires/:id/approve': 'session',
  'POST /auditor-rooms': 'session',
  'POST /auditor-rooms/:id/revoke': 'session',
  'POST /auditor-rooms/:id/unlock': 'session',
  'GET /frameworks/:id/statement-of-applicability': 'binary',
  'GET /manual-evidence/:id/download': 'binary',
  'GET /questionnaires/:id/export': 'binary',
  'GET /exports/:id/download': 'binary',
  'GET /feeds/:id/keys': 'credentials',
  'POST /feeds/:id/keys': 'credentials',
  'POST /feed-keys/:id/revoke': 'credentials',
  'POST /feeds/:feed_key/records': 'public-inbound',
  'GET /public/room': 'public-inbound',
  'GET /public/room/controls/:id': 'public-inbound',
  'GET /public/room/evidence/:id': 'public-inbound',
  'POST /public/room/requests': 'public-inbound',
  'POST /internal/engines/:name': 'internal',
  'POST /internal/events': 'internal',
};

// Words the surface-map skip annotation must use for each category.
const SKIP_WORDS: Record<Category, RegExp> = {
  session: /session required/,
  binary: /binary/,
  credentials: /auth\/credentials/,
  'public-inbound': /public-inbound/,
  internal: /internal service-to-service/,
};

/** `METHOD /path` with every path parameter written `:p`, so client templates compare. */
const shape = (route: string) => route.replace(/:[a-z_]+/g, ':p');

function routes(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.ts'))) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const declared = [...src.matchAll(/fastify\.(get|post|patch|put|delete)(?:<[^>]*>)?\(/g)].length;
    const found = [...src.matchAll(/fastify\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)].map(
      (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
    );
    expect(found.length, `${file}: every route path is a string literal`).toBe(declared);
    out.push(...found);
  }
  return out;
}

/** method name -> `METHOD /path` (shaped) for every client method that sends a request. */
function clientMethods(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^ {4}(\w+): \([^]*?request\(\s*'(GET|POST|PATCH|PUT|DELETE)',\s*[`']([^`']*)[`']/gm;
  for (const m of CLIENT.matchAll(re)) {
    const path = m[3]!.replace(/\$\{qs\([^]*$/, '').replace(/\$\{[^}]+\}/g, ':p');
    out.set(m[1]!, `${m[2]} ${path}`);
  }
  return out;
}

const ROUTES = routes();
const METHODS = clientMethods();
const CLIENT_ROUTES = new Set([...METHODS.values()]);

/** The Bastion section of the surface map, one row per `METHOD /v1/...`. */
function mapRows(): Map<string, string> {
  const start = MAP.indexOf('## Bastion (app)');
  expect(start).toBeGreaterThan(0);
  const next = MAP.indexOf('\n## ', start + 1);
  const section = MAP.slice(start, next === -1 ? undefined : next);
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    const m = /^\| `(GET|POST|PATCH|PUT|DELETE) \/v1(\/[^`]*)` \| ([^|]+) \|/.exec(line);
    if (m) rows.set(`${m[1]} ${m[2]}`, m[3]!.trim());
  }
  return rows;
}

describe('Bastion MCP parity cross-walk (M10)', () => {
  it('reads every route file (sanity)', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(112);
    expect(new Set(ROUTES).size).toBe(ROUTES.length);
  });

  it('every route has a client method or a sanctioned skip, never both', () => {
    const missing = ROUTES.filter((r) => !SKIPS[r] && !CLIENT_ROUTES.has(shape(r)));
    expect(missing, 'routes with neither a client method nor a sanctioned skip').toEqual([]);
    const both = ROUTES.filter((r) => SKIPS[r] && CLIENT_ROUTES.has(shape(r)));
    expect(both, 'skipped routes that the client calls anyway').toEqual([]);
  });

  it('every skip names a route that exists', () => {
    const stale = Object.keys(SKIPS).filter((s) => !ROUTES.includes(s));
    expect(stale).toEqual([]);
  });

  it('every client method calls a real route, and a registered tool (or search_everything) uses it', () => {
    const shapedRoutes = new Set(ROUTES.map(shape));
    const unknown = [...METHODS].filter(([, r]) => !shapedRoutes.has(r)).map(([n, r]) => `${n}: ${r}`);
    expect(unknown).toEqual([]);
    const used = new Set([...TOOLS.matchAll(/client\.(\w+)\(/g)].map((m) => m[1]!));
    const orphans = [...METHODS.keys()].filter((n) => !used.has(n) && n !== 'search');
    expect(orphans, 'client methods no tool calls').toEqual([]);
    // GET /search is read by the platform search_everything, not by a bastion_* tool.
    expect(METHODS.get('search')).toBe('GET /search');
    expect(SEARCH_TOOLS).toMatch(/\$\{base\}\/search\?/);
  });

  it('no registered tool calls a session-only route (the client has no method for one)', () => {
    for (const [route, cat] of Object.entries(SKIPS)) {
      if (cat === 'session') expect(CLIENT_ROUTES.has(shape(route)), route).toBe(false);
    }
  });

  it('the surface map has one row per route, saying the same thing', () => {
    const rows = mapRows();
    const missing = ROUTES.filter((r) => !rows.has(r));
    expect(missing, 'routes missing from the Bastion section of mcp-endpoint-mapping.md').toEqual([]);
    const extra = [...rows.keys()].filter((r) => !ROUTES.includes(r));
    expect(extra, 'surface-map rows for routes that do not exist').toEqual([]);
    for (const r of ROUTES) {
      const cell = rows.get(r)!;
      const skip = SKIPS[r];
      if (skip) {
        expect(cell, r).toMatch(/^— _\(skip: /);
        expect(cell, r).toMatch(SKIP_WORDS[skip]);
      } else {
        expect(cell, r).toMatch(/^`(bastion_[a-z_]+|search_everything)`/);
      }
    }
  });

  it('every tool the surface map names for a Bastion route is a registered tool (or search_everything)', () => {
    const names = new Set([...TOOLS.matchAll(/name: '(bastion_[a-z_]+)'/g)].map((m) => m[1]!));
    for (const [route, cell] of mapRows()) {
      for (const t of cell.matchAll(/`(bastion_[a-z_]+)`/g)) expect(names.has(t[1]!), `${route}: ${t[1]}`).toBe(true);
    }
  });

  it('the surface map no longer calls the registered Bastion tools pending (#333)', () => {
    const summary = MAP.split('\n').find((l) => /^\| Bastion\b/.test(l));
    expect(summary, 'Bastion row in the coverage summary table').toBeDefined();
    expect(summary).not.toMatch(/pending/i);
    const start = MAP.indexOf('## Bastion (app)');
    const next = MAP.indexOf('\n## ', start + 1);
    const section = MAP.slice(start, next === -1 ? undefined : next);
    expect(section).not.toMatch(/pending `bastion_\*` tool|used by a pending tool/);
  });
});
