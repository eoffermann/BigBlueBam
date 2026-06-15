import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../src/middleware/api-client.js';
import { registerCompositeTools } from '../src/tools/composite-tools.js';

/**
 * Partial-failure coverage for account_view / project_view / user_view
 * (AGENTIC_TODO §6 Wave 3).
 *
 * The composites fan out in parallel with per-arm 5s AbortController
 * timeouts. We drive the mocked fetch implementation based on the URL
 * prefix so each arm can be independently succeeded, errored, or
 * stalled. For stall simulation we use vitest's fake timers so the
 * 5s timeout fires without making the test suite slow.
 */

const logger = pino({ level: 'silent' });

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: ToolHandler;
}

function createMockServer(): { server: McpServer; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: ToolHandler,
    ) => {
      tools.set(name, { name, description, schema, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

const URLS = {
  apiUrl: 'http://api:4000',
  bondApiUrl: 'http://bond-api:4009/v1',
  helpdeskApiUrl: 'http://helpdesk-api:4001',
  billApiUrl: 'http://bill-api:4014/v1',
  bearingApiUrl: 'http://bearing-api:4007/v1',
  briefApiUrl: 'http://brief-api:4005/v1',
  beaconApiUrl: 'http://beacon-api:4004',
};

const COMPANY_ID = '550e8400-e29b-41d4-a716-446655440001';
const CONTACT_ID = '550e8400-e29b-41d4-a716-446655440002';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440003';
const USER_ID = '550e8400-e29b-41d4-a716-446655440004';
const DEAL_OWNER_ID = '550e8400-e29b-41d4-a716-446655440005';

/**
 * Small router over a per-URL lookup table. Each entry produces a Response
 * shape; missing entries default to a 404 JSON so fan-out arms gracefully
 * report an arm-level failure rather than hang the suite.
 *
 * A value can be:
 *   - { ok: true, json }        - respond 200 with the given JSON.
 *   - { ok: false, status }     - respond non-ok with { error: ... }.
 *   - 'stall'                   - never resolve (used with fake timers).
 *   - 'error'                   - throw a network error.
 */
type Responder =
  | { ok: true; json: unknown }
  | { ok: false; status: number; json?: unknown }
  | 'stall'
  | 'error';

interface FetchRouter {
  match: (url: string) => Responder | undefined;
}

function installFetch(router: FetchRouter): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const responder = router.match(url);
    if (!responder) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'no route matched in test', url }),
      } as unknown as Response;
    }

    if (responder === 'stall') {
      // Respect AbortSignal so the 5s AbortController fires.
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          });
        }
        // never resolves
      }) as Promise<Response>;
    }
    if (responder === 'error') {
      throw new Error('network down');
    }
    if (responder.ok) {
      return {
        ok: true,
        status: 200,
        json: async () => responder.json,
      } as unknown as Response;
    }
    return {
      ok: false,
      status: responder.status,
      json: async () => responder.json ?? { error: 'bad status' },
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function buildTools(): Map<string, RegisteredTool> {
  const api = new ApiClient('http://api:4000', 'test-token', logger);
  const mock = createMockServer();
  registerCompositeTools(mock.server, api, URLS);
  return mock.tools;
}

/** Build a router from a list of (matchFn, responder) pairs. */
function routerOf(
  pairs: Array<[(url: string) => boolean, Responder]>,
): FetchRouter {
  return {
    match(url: string) {
      for (const [pred, responder] of pairs) {
        if (pred(url)) return responder;
      }
      return undefined;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// account_view
// ---------------------------------------------------------------------------

describe('account_view', () => {
  it('returns the full response with partial=false when all arms succeed', async () => {
    const router = routerOf([
      // company resolution
      [
        (u) => u.endsWith(`/companies/${COMPANY_ID}`),
        {
          ok: true,
          json: {
            data: {
              id: COMPANY_ID,
              name: 'Acme Inc',
              domain: 'acme.com',
              owner_id: USER_ID,
            },
          },
        },
      ],
      // deals
      [
        (u) => u.includes('/deals?') && u.includes('company_id='),
        {
          ok: true,
          json: {
            data: [
              {
                id: 'd1',
                name: 'Deal 1',
                stage_id: 'stage-a',
                value: 10000,
                expected_close_date: '2026-06-01',
                owner_id: DEAL_OWNER_ID,
              },
            ],
          },
        },
      ],
      // helpdesk tickets
      [
        (u) => u.includes('/tickets?status=open'),
        {
          ok: true,
          json: {
            data: [
              {
                id: 't1',
                ticket_number: 42,
                subject: 'Login broken',
                status: 'open',
                priority: 'high',
                updated_at: '2026-04-18T12:00:00Z',
              },
            ],
          },
        },
      ],
      // bill clients
      [
        (u) => u.endsWith('/clients'),
        { ok: true, json: { data: [{ id: 'bc1', bond_company_id: COMPANY_ID }] } },
      ],
      // bill invoices
      [
        (u) => u.includes('/invoices?') && u.includes('client_id='),
        {
          ok: true,
          json: {
            data: [
              {
                id: 'inv1',
                invoice_number: 'INV-0001',
                total: 50000,
                status: 'sent',
                due_date: '2026-05-01',
                invoice_date: '2026-04-01',
              },
            ],
          },
        },
      ],
      // unified activity (account_view recent_activity)
      [
        (u) => u.includes('/v1/activity/unified') && u.includes('entity_type=bond.company'),
        {
          ok: true,
          json: {
            data: [
              {
                id: 'a1',
                source_app: 'bond',
                action: 'deal.created',
                actor_id: USER_ID,
                created_at: '2026-04-18T10:00:00Z',
              },
            ],
            meta: {},
          },
        },
      ],
      // users lookups for owners arm
      [
        (u) => u.endsWith(`/users/${USER_ID}`),
        { ok: true, json: { data: { id: USER_ID, display_name: 'Account Owner' } } },
      ],
      [
        (u) => u.endsWith(`/users/${DEAL_OWNER_ID}`),
        { ok: true, json: { data: { id: DEAL_OWNER_ID, display_name: 'Deal Owner' } } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('account_view')!.handler({ company_id: COMPANY_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(false);
    expect(parsed.missing).toEqual([]);
    expect(parsed.resolved.company_id).toBe(COMPANY_ID);
    expect(parsed.resolved.resolved_from).toBe('company_id');
    expect(parsed.deals).toHaveLength(1);
    expect(parsed.tickets).toHaveLength(1);
    expect(parsed.invoices).toHaveLength(1);
    expect(parsed.recent_activity).toHaveLength(1);
    expect(parsed.owners.map((o: { user_id: string }) => o.user_id)).toEqual(
      expect.arrayContaining([USER_ID, DEAL_OWNER_ID]),
    );
  });

  it('resolves via domain first and fans out', async () => {
    const router = routerOf([
      // /companies?search=acme.com returns one row matching the domain.
      [
        (u) => u.includes('/companies?') && u.includes('search='),
        {
          ok: true,
          json: {
            data: [
              { id: COMPANY_ID, name: 'Acme Inc', domain: 'acme.com' },
              { id: 'c2', name: 'Not Acme', domain: 'notacme.com' },
            ],
          },
        },
      ],
      // company owner lookup (owners arm still needs this)
      [
        (u) => u.endsWith(`/companies/${COMPANY_ID}`),
        { ok: true, json: { data: { id: COMPANY_ID, owner_id: null } } },
      ],
      [
        (u) => u.includes('/deals?') && u.includes('company_id='),
        { ok: true, json: { data: [] } },
      ],
      [
        (u) => u.includes('/tickets?status=open'),
        { ok: true, json: { data: [] } },
      ],
      [(u) => u.endsWith('/clients'), { ok: true, json: { data: [] } }],
      [
        (u) => u.includes('/v1/activity/unified'),
        { ok: true, json: { data: [], meta: {} } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('account_view')!.handler({ domain: 'acme.com' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.resolved.resolved_from).toBe('domain');
    expect(parsed.resolved.company_id).toBe(COMPANY_ID);
  });

  it('marks partial=true when one arm fails (helpdesk)', async () => {
    const router = routerOf([
      [
        (u) => u.endsWith(`/companies/${COMPANY_ID}`),
        {
          ok: true,
          json: {
            data: { id: COMPANY_ID, name: 'Acme', domain: null, owner_id: null },
          },
        },
      ],
      [
        (u) => u.includes('/deals?') && u.includes('company_id='),
        { ok: true, json: { data: [] } },
      ],
      // tickets arm fails
      [(u) => u.includes('/tickets?status=open'), { ok: false, status: 500 }],
      [(u) => u.endsWith('/clients'), { ok: true, json: { data: [] } }],
      [
        (u) => u.includes('/v1/activity/unified'),
        { ok: true, json: { data: [], meta: {} } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('account_view')!.handler({ company_id: COMPANY_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(true);
    expect(parsed.missing).toContain('tickets');
    expect(parsed.deals).toEqual([]);
  });

  it('returns 502 COMPOSITE_FAILED when every arm fails', async () => {
    // Resolve via domain so the resolver's /companies?search=... succeeds
    // (separate from the owners arm's /companies/:id call). The owners arm
    // cannot recover without the company fetch, so routing /companies/:id
    // to a network error forces that arm to fail as well.
    const router = routerOf([
      [
        (u) => u.includes('/companies?') && u.includes('search='),
        {
          ok: true,
          json: {
            data: [{ id: COMPANY_ID, name: 'Acme', domain: 'acme.com' }],
          },
        },
      ],
      [(u) => u.endsWith(`/companies/${COMPANY_ID}`), 'error'],
      [(u) => u.includes('/deals?'), { ok: false, status: 500 }],
      [(u) => u.includes('/tickets?status=open'), { ok: false, status: 500 }],
      [(u) => u.endsWith('/clients'), { ok: false, status: 500 }],
      [(u) => u.includes('/v1/activity/unified'), { ok: false, status: 500 }],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('account_view')!.handler({ domain: 'acme.com' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error.code).toBe('COMPOSITE_FAILED');
    expect(parsed.status).toBe(502);
  });

  it('surfaces NOT_FOUND when the resolver cannot locate a company', async () => {
    const router = routerOf([
      [
        (u) => u.includes('/companies?') && u.includes('search='),
        { ok: true, json: { data: [] } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools
      .get('account_view')!
      .handler({ domain: 'unknown.example' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error.code).toBe('NOT_FOUND');
  });

  it('requires at least one identifier', async () => {
    installFetch(routerOf([]));
    const tools = buildTools();
    const result = await tools.get('account_view')!.handler({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('resolves via contact_id using the primary associated company', async () => {
    const router = routerOf([
      [
        (u) => u.endsWith(`/contacts/${CONTACT_ID}`),
        {
          ok: true,
          json: {
            data: {
              id: CONTACT_ID,
              companies: [
                { company_id: COMPANY_ID, name: 'Acme', domain: 'acme.com', is_primary: true },
                { company_id: 'c2', name: 'Other', domain: 'other.com', is_primary: false },
              ],
            },
          },
        },
      ],
      [
        (u) => u.endsWith(`/companies/${COMPANY_ID}`),
        { ok: true, json: { data: { id: COMPANY_ID, owner_id: null } } },
      ],
      [
        (u) => u.includes('/deals?') && u.includes('company_id='),
        { ok: true, json: { data: [] } },
      ],
      [(u) => u.includes('/tickets?status=open'), { ok: true, json: { data: [] } }],
      [(u) => u.endsWith('/clients'), { ok: true, json: { data: [] } }],
      [
        (u) => u.includes('/v1/activity/unified'),
        { ok: true, json: { data: [], meta: {} } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('account_view')!.handler({ contact_id: CONTACT_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.resolved.resolved_from).toBe('contact_id');
    expect(parsed.resolved.company_id).toBe(COMPANY_ID);
  });
});

// ---------------------------------------------------------------------------
// project_view
// ---------------------------------------------------------------------------

describe('project_view', () => {
  it('returns a full response with partial=false', async () => {
    const router = routerOf([
      [
        (u) => u.endsWith(`/projects/${PROJECT_ID}`),
        {
          ok: true,
          json: {
            data: { id: PROJECT_ID, name: 'Alpha', slug: 'alpha', org_id: 'org-1' },
          },
        },
      ],
      [
        (u) => u.includes(`/projects/${PROJECT_ID}/tasks`),
        {
          ok: true,
          json: {
            data: [
              { id: 'tsk1', state_category: 'todo' },
              { id: 'tsk2', state_category: 'done' },
              { id: 'tsk3', state_category: 'active' },
            ],
          },
        },
      ],
      [
        (u) => u.endsWith(`/projects/${PROJECT_ID}/sprints`),
        {
          ok: true,
          json: {
            data: [
              { id: 's1', name: 'Sprint 1', status: 'completed', end_date: '2026-03-01' },
              { id: 's2', name: 'Sprint 2', status: 'active', end_date: '2026-05-01' },
            ],
          },
        },
      ],
      [
        (u) => u.includes('/goals?') && u.includes(`project_id=${PROJECT_ID}`),
        {
          ok: true,
          json: {
            data: [
              { id: 'g1', title: 'Ship it', status: 'on_track', progress: 0.42 },
            ],
          },
        },
      ],
      [
        (u) => u.includes('/documents?') && u.includes(`project_id=${PROJECT_ID}`),
        {
          ok: true,
          json: {
            data: [
              {
                id: 'doc1',
                title: 'Launch plan',
                updated_at: '2026-04-10T10:00:00Z',
                created_by: USER_ID,
              },
            ],
          },
        },
      ],
      [
        (u) => u.includes('/beacons?') && u.includes(`project_id=${PROJECT_ID}`),
        {
          ok: true,
          json: {
            data: [
              { id: 'b1', title: 'Runbook', updated_at: '2026-04-12T09:00:00Z' },
            ],
          },
        },
      ],
      // top_contributors prefers unified; let it succeed.
      [
        (u) => u.includes('/v1/activity/unified') && u.includes('entity_type=bam.project'),
        {
          ok: true,
          json: {
            data: [
              { id: 'ev1', actor_id: USER_ID, created_at: new Date().toISOString() },
              { id: 'ev2', actor_id: USER_ID, created_at: new Date().toISOString() },
              { id: 'ev3', actor_id: DEAL_OWNER_ID, created_at: new Date().toISOString() },
            ],
            meta: {},
          },
        },
      ],
      [
        (u) => u.endsWith(`/users/${USER_ID}`),
        { ok: true, json: { data: { id: USER_ID, display_name: 'Alice' } } },
      ],
      [
        (u) => u.endsWith(`/users/${DEAL_OWNER_ID}`),
        { ok: true, json: { data: { id: DEAL_OWNER_ID, display_name: 'Bob' } } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('project_view')!.handler({ project_id: PROJECT_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(false);
    expect(parsed.missing).toEqual([]);
    expect(parsed.project.id).toBe(PROJECT_ID);
    // open tasks count excludes done/cancelled
    expect(parsed.open_tasks_count).toBe(2);
    expect(parsed.active_sprint?.id).toBe('s2');
    expect(parsed.goals_linked).toHaveLength(1);
    expect(parsed.recent_brief_docs).toHaveLength(1);
    expect(parsed.recent_beacon_entries).toHaveLength(1);
    expect(parsed.top_contributors[0]!.user_id).toBe(USER_ID);
    expect(parsed.top_contributors[0]!.action_count).toBe(2);
  });

  it('marks partial=true with brief listed as missing when the Brief arm fails', async () => {
    const router = routerOf([
      [
        (u) => u.endsWith(`/projects/${PROJECT_ID}`),
        {
          ok: true,
          json: {
            data: { id: PROJECT_ID, name: 'Alpha', slug: 'alpha', org_id: 'org-1' },
          },
        },
      ],
      [
        (u) => u.includes(`/projects/${PROJECT_ID}/tasks`),
        { ok: true, json: { data: [] } },
      ],
      [
        (u) => u.endsWith(`/projects/${PROJECT_ID}/sprints`),
        { ok: true, json: { data: [] } },
      ],
      [(u) => u.includes('/goals?'), { ok: true, json: { data: [] } }],
      // Brief down
      [(u) => u.includes('/documents?'), { ok: false, status: 503 }],
      [(u) => u.includes('/beacons?'), { ok: true, json: { data: [] } }],
      [
        (u) => u.includes('/v1/activity/unified'),
        { ok: true, json: { data: [], meta: {} } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('project_view')!.handler({ project_id: PROJECT_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(true);
    expect(parsed.missing).toContain('recent_brief_docs');
    // Other fields still present
    expect(parsed.project.id).toBe(PROJECT_ID);
    expect(parsed.recent_brief_docs).toEqual([]);
    expect(parsed.recent_beacon_entries).toEqual([]);
  });

  it('returns NOT_FOUND (no stub echo) when the project arm itself is denied (#28 Stance A)', async () => {
    const router = routerOf([
      // The project read is denied (a non-member sees 404, same as get_project)…
      [(u) => u.endsWith(`/projects/${PROJECT_ID}`), { ok: false, status: 404 }],
      // …while sibling arms on the same api base happen to succeed.
      [(u) => u.includes(`/projects/${PROJECT_ID}/tasks`), { ok: true, json: { data: [] } }],
      [(u) => u.endsWith(`/projects/${PROJECT_ID}/sprints`), { ok: true, json: { data: [] } }],
      [(u) => u.includes('/goals?'), { ok: true, json: { data: [] } }],
      [(u) => u.includes('/documents?'), { ok: true, json: { data: [] } }],
      [(u) => u.includes('/beacons?'), { ok: true, json: { data: [] } }],
      [(u) => u.includes('/v1/activity/unified'), { ok: true, json: { data: [], meta: {} } }],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('project_view')!.handler({ project_id: PROJECT_ID });
    const parsed = JSON.parse(result.content[0]!.text);
    // Hide existence: NOT_FOUND, and crucially NO stub echoing the project id
    // and NO `missing` array that could distinguish denied-vs-empty.
    expect(parsed.error?.code).toBe('NOT_FOUND');
    expect(parsed.project).toBeUndefined();
    expect(parsed.missing).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain(PROJECT_ID);
  });

  it('hits the 5s AbortController when an arm stalls', async () => {
    vi.useFakeTimers();
    const router = routerOf([
      [
        (u) => u.endsWith(`/projects/${PROJECT_ID}`),
        {
          ok: true,
          json: { data: { id: PROJECT_ID, name: 'Alpha', slug: null, org_id: 'org-1' } },
        },
      ],
      [
        (u) => u.includes(`/projects/${PROJECT_ID}/tasks`),
        { ok: true, json: { data: [] } },
      ],
      [
        (u) => u.endsWith(`/projects/${PROJECT_ID}/sprints`),
        { ok: true, json: { data: [] } },
      ],
      [(u) => u.includes('/goals?'), { ok: true, json: { data: [] } }],
      [(u) => u.includes('/documents?'), { ok: true, json: { data: [] } }],
      // Beacon stalls; the 5s timeout must fire for the arm to be marked missing.
      [(u) => u.includes('/beacons?'), 'stall'],
      [
        (u) => u.includes('/v1/activity/unified'),
        { ok: true, json: { data: [], meta: {} } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const promise = tools.get('project_view')!.handler({ project_id: PROJECT_ID });
    // Advance past the 5s timeout so the AbortController fires.
    await vi.advanceTimersByTimeAsync(5100);
    const result = await promise;
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(true);
    expect(parsed.missing).toContain('recent_beacon_entries');
  });

  it('returns 502 COMPOSITE_FAILED when every project arm fails', async () => {
    const router = routerOf([
      // Every arm errors out.
      [(u) => u.includes(`/projects/${PROJECT_ID}`), { ok: false, status: 500 }],
      [(u) => u.includes('/goals?'), { ok: false, status: 500 }],
      [(u) => u.includes('/documents?'), { ok: false, status: 500 }],
      [(u) => u.includes('/beacons?'), { ok: false, status: 500 }],
      [(u) => u.includes('/v1/activity/unified'), { ok: false, status: 500 }],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('project_view')!.handler({ project_id: PROJECT_ID });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error.code).toBe('COMPOSITE_FAILED');
    expect(parsed.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// user_view
// ---------------------------------------------------------------------------

describe('user_view', () => {
  it('returns a full response with partial=false', async () => {
    const router = routerOf([
      [
        (u) => u.endsWith(`/users/${USER_ID}`),
        {
          ok: true,
          json: {
            data: {
              id: USER_ID,
              email: 'a@b.com',
              display_name: 'Alice',
              kind: 'human',
              role: 'member',
            },
          },
        },
      ],
      [
        (u) => u.includes('/deals?') && u.includes(`owner_id=${USER_ID}`),
        {
          ok: true,
          json: {
            data: [{ id: 'd1', name: 'Deal', stage_id: 'stg', value: 1000 }],
          },
        },
      ],
      [
        (u) => u.includes('/tickets/search?') && u.includes(`assignee_id=${USER_ID}`),
        {
          ok: true,
          json: {
            data: [
              { id: 'tkt1', number: 7, subject: 'Help me', status: 'open' },
            ],
          },
        },
      ],
      [
        (u) => u.includes('/goals?') && u.includes(`owner_id=${USER_ID}`),
        {
          ok: true,
          json: { data: [{ id: 'g1', title: 'OKR', progress: 0.8 }] },
        },
      ],
      [
        (u) =>
          u.includes('/v1/activity/unified/by-actor') && u.includes(`actor_id=${USER_ID}`),
        {
          ok: true,
          json: {
            data: [
              {
                id: 'ev1',
                source_app: 'bam',
                action: 'task.update',
                entity_id: 'task-1',
                created_at: '2026-04-18T10:00:00Z',
              },
            ],
            meta: {},
          },
        },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('user_view')!.handler({ user_id: USER_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(false);
    expect(parsed.missing).toEqual([]);
    expect(parsed.user.id).toBe(USER_ID);
    expect(parsed.user.kind).toBe('human');
    expect(parsed.owned_deals).toHaveLength(1);
    expect(parsed.open_tickets).toHaveLength(1);
    expect(parsed.goals_owned).toHaveLength(1);
    expect(parsed.recent_activity).toHaveLength(1);
  });

  it('returns 502 COMPOSITE_FAILED when every user arm fails', async () => {
    const router = routerOf([
      [(u) => u.endsWith(`/users/${USER_ID}`), { ok: false, status: 500 }],
      [(u) => u.includes('/deals?'), { ok: false, status: 500 }],
      [(u) => u.includes('/tickets/search?'), { ok: false, status: 500 }],
      [(u) => u.includes('/goals?'), { ok: false, status: 500 }],
      [(u) => u.includes('/v1/activity/unified/by-actor'), { ok: false, status: 500 }],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('user_view')!.handler({ user_id: USER_ID });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error.code).toBe('COMPOSITE_FAILED');
  });

  it('marks partial=true when a single arm fails', async () => {
    const router = routerOf([
      [
        (u) => u.endsWith(`/users/${USER_ID}`),
        {
          ok: true,
          json: {
            data: {
              id: USER_ID,
              email: 'a@b.com',
              display_name: 'Alice',
              kind: 'human',
              role: 'member',
            },
          },
        },
      ],
      [(u) => u.includes('/deals?'), { ok: true, json: { data: [] } }],
      // Helpdesk arm fails.
      [(u) => u.includes('/tickets/search?'), { ok: false, status: 503 }],
      [(u) => u.includes('/goals?'), { ok: true, json: { data: [] } }],
      [
        (u) => u.includes('/v1/activity/unified/by-actor'),
        { ok: true, json: { data: [], meta: {} } },
      ],
    ]);
    installFetch(router);

    const tools = buildTools();
    const result = await tools.get('user_view')!.handler({ user_id: USER_ID });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.partial).toBe(true);
    expect(parsed.missing).toContain('open_tickets');
    expect(parsed.open_tickets).toEqual([]);
  });
});
