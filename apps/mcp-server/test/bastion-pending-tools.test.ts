import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Bastion's MCP handlers are written and tested from M2 on but stay OUT of the registered,
// counted tool surface until the M11 merge unit (spec 5.4). This suite pins both halves: the
// handlers call the right bastion-api routes with shared-Zod-typed input, and nothing reads
// them as a registered tool module yet.

const captured: Array<{ name: string; input: Record<string, unknown>; handler: (a: never) => Promise<unknown> }> = [];
vi.mock('../src/lib/register-tool.js', () => ({
  registerTool: (_server: unknown, opts: { name: string; input: Record<string, unknown>; handler: (a: never) => Promise<unknown> }) => {
    captured.push(opts);
  },
}));

const SRC = join(__dirname, '..', 'src');
const PENDING = readFileSync(join(SRC, 'tools-pending', 'bastion.ts'), 'utf8');
const SERVER = readFileSync(join(SRC, 'server.ts'), 'utf8');

const FW = '11111111-1111-4111-8111-111111111111';
const CTRL = '22222222-2222-4222-8222-222222222222';
const ASSERTION = '33333333-3333-4333-8333-333333333333';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
const fakeFetch = async (url: string, init: RequestInit) => {
  calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function memoryTokenStore() {
  const m = new Map<string, { action: string; resource_id: string; ttlMs: number }>();
  return {
    entries: m,
    set: async (k: string, v: { action: string; resource_id: string; ttlMs: number }) => {
      m.set(k, v);
    },
    get: async (k: string) => m.get(k) ?? null,
    delete: async (k: string) => {
      m.delete(k);
    },
    close: async () => {},
  };
}

async function load(store: ReturnType<typeof memoryTokenStore> | null = memoryTokenStore()) {
  captured.length = 0;
  const { registerBastionTools } = await import('../src/tools-pending/bastion.js');
  const api = { token: 'bbam_test' } as never;
  registerBastionTools({} as never, api, 'http://bastion-api:4024/v1/', fakeFetch, store ?? undefined);
  return (name: string) => {
    const t = captured.find((c) => c.name === name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t;
  };
}

beforeEach(() => {
  calls = [];
});

describe('Bastion pending tools stay out of the registered surface until M11', () => {
  it('lives under src/tools-pending, not src/tools, and is not named *-tools.ts', () => {
    expect(existsSync(join(SRC, 'tools', 'bastion-tools.ts'))).toBe(false);
    expect(readdirSync(join(SRC, 'tools-pending')).filter((f) => f.endsWith('-tools.ts'))).toEqual([]);
  });

  it('is not imported or registered by server.ts', () => {
    expect(SERVER).not.toMatch(/bastion/i);
  });

  it('every handler goes through registerTool (agent policies apply once registered)', () => {
    // 14 milestone handlers (M3 + M4) + 9 #196 parity handlers + M5 (8 evidence + 2 feed admin)
    // + M6 (9 gap, fix, exception and drift handlers).
    expect((PENDING.match(/registerTool\(server, \{/g) ?? []).length).toBe(42);
    expect(PENDING).not.toMatch(/server\.tool\(/);
  });
});

describe('Bastion M3 tool handlers', () => {
  it('registers exactly the M3 roster', async () => {
    await load();
    const { BASTION_PENDING_TOOL_NAMES, BASTION_ADMIN_TOOL_NAMES, BASTION_EVIDENCE_TOOL_NAMES, BASTION_DECISION_TOOL_NAMES } = await import(
      '../src/tools-pending/bastion.js'
    );
    expect(captured.map((c) => c.name).sort()).toEqual(
      [...BASTION_PENDING_TOOL_NAMES, ...BASTION_ADMIN_TOOL_NAMES, ...BASTION_EVIDENCE_TOOL_NAMES, ...BASTION_DECISION_TOOL_NAMES].sort(),
    );
  });

  it('has no tool for a vouching act (confirm or reject a check): auth, session required (spec 2.8, #136)', async () => {
    await load();
    const names = captured.map((c) => c.name).join(' ');
    expect(names).not.toMatch(/confirm|reject|attest|vouch/);
  });

  it('bastion_list_frameworks lists adopted frameworks and templates, forwarding the bearer token', async () => {
    const tool = await load();
    const seen: Array<string | undefined> = [];
    const { createBastionClient } = await import('../src/clients/bastion-client.js');
    const client = createBastionClient('http://x/v1', { token: 'bbam_k' } as never, async (_u, init) => {
      seen.push((init.headers as Record<string, string>).Authorization);
      return new Response('{}', { status: 200 });
    });
    await client.listFrameworks();
    expect(seen).toEqual(['Bearer bbam_k']);

    await tool('bastion_list_frameworks').handler({} as never);
    expect(calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([
      'GET http://bastion-api:4024/v1/frameworks',
      'GET http://bastion-api:4024/v1/library/templates',
    ]);
    calls = [];
    await tool('bastion_list_frameworks').handler({ framework_id: FW, include_requirements: true } as never);
    expect(calls.map((c) => c.url)).toEqual([
      `http://bastion-api:4024/v1/frameworks/${FW}`,
      `http://bastion-api:4024/v1/frameworks/${FW}/requirements`,
    ]);
  });

  it('bastion_compile_framework starts a run or lists runs', async () => {
    const tool = await load();
    await tool('bastion_compile_framework').handler({ framework_id: FW } as never);
    await tool('bastion_compile_framework').handler({ framework_id: FW, action: 'list_runs' } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST http://bastion-api:4024/v1/frameworks/${FW}/compile`,
      `GET http://bastion-api:4024/v1/frameworks/${FW}/compile-runs`,
    ]);
  });

  it('bastion_list_controls passes the framework view and filters as query params', async () => {
    const tool = await load();
    await tool('bastion_list_controls').handler({ framework_id: FW, setup: 'not_set_up' } as never);
    expect(calls[0]!.url).toBe(`http://bastion-api:4024/v1/controls?framework_id=${FW}&setup=not_set_up`);
  });

  it('bastion_control_status reads one control', async () => {
    const tool = await load();
    await tool('bastion_control_status').handler({ control_id: CTRL } as never);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `http://bastion-api:4024/v1/controls/${CTRL}` });
  });

  it('bastion_propose_assertion proposes or revises, never both', async () => {
    const tool = await load();
    const proposal = { kind: 'probe', probe_key: 'keys.max_age', plain_statement: 'No key older than 90 days.' };
    await tool('bastion_propose_assertion').handler({ control_id: CTRL, proposal } as never);
    await tool('bastion_propose_assertion').handler({
      revise_assertion_id: ASSERTION,
      revision: { expected_population: ['castaways/radio'] },
    } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST http://bastion-api:4024/v1/controls/${CTRL}/assertions`,
      `POST http://bastion-api:4024/v1/assertions/${ASSERTION}/revise`,
    ]);
    expect(calls[0]!.body).toEqual(proposal);
    calls = [];
    const bad = (await tool('bastion_propose_assertion').handler({ control_id: CTRL, revise_assertion_id: ASSERTION } as never)) as {
      isError?: boolean;
    };
    expect(bad.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('the proposal input is the shared Zod schema (closed probe menu)', async () => {
    const tool = await load();
    const schema = tool('bastion_propose_assertion').input.proposal as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ kind: 'probe', probe_key: 'keys.max_age', plain_statement: 'x' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'probe', probe_key: 'raw.sql', plain_statement: 'x' }).success).toBe(false);
  });

  it('bastion_list_probes and bastion_get_setup_status are plain reads', async () => {
    const tool = await load();
    await tool('bastion_list_probes').handler({} as never);
    await tool('bastion_get_setup_status').handler({} as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://bastion-api:4024/v1/probes',
      'GET http://bastion-api:4024/v1/setup',
    ]);
  });

  it('M4: bastion_run_evaluation starts a full or one-control run; bastion_list_evaluations lists or reads one', async () => {
    const tool = await load();
    await tool('bastion_run_evaluation').handler({} as never);
    await tool('bastion_run_evaluation').handler({ control_id: CTRL } as never);
    await tool('bastion_list_evaluations').handler({ status: 'partial', limit: 5 } as never);
    await tool('bastion_list_evaluations').handler({ run_id: ASSERTION } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://bastion-api:4024/v1/evaluations',
      'POST http://bastion-api:4024/v1/evaluations',
      'GET http://bastion-api:4024/v1/evaluations?status=partial&limit=5',
      `GET http://bastion-api:4024/v1/evaluations/${ASSERTION}`,
    ]);
    expect(calls[0]!.body).toEqual({});
    expect(calls[1]!.body).toEqual({ control_id: CTRL });
  });

  it('M4: the run input is the shared Zod body (no stray fields reach bastion-api)', async () => {
    const tool = await load();
    const input = tool('bastion_run_evaluation').input as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(Object.keys(input)).toEqual(['control_id']);
    expect(input.control_id!.safeParse('not-a-uuid').success).toBe(false);
  });

  it('M4: evidence, verification, seals and restores are plain reads on the right routes', async () => {
    const tool = await load();
    await tool('bastion_evidence_for').handler({ control_id: CTRL, assertion_id: ASSERTION, limit: 10 } as never);
    await tool('bastion_get_evidence').handler({ evidence_id: ASSERTION } as never);
    await tool('bastion_verify_evidence').handler({ evidence_id: ASSERTION } as never);
    await tool('bastion_list_seals').handler({} as never);
    await tool('bastion_list_restores').handler({} as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET http://bastion-api:4024/v1/controls/${CTRL}/evidence?assertion_id=${ASSERTION}&limit=10`,
      `GET http://bastion-api:4024/v1/evidence/${ASSERTION}`,
      `GET http://bastion-api:4024/v1/evidence/${ASSERTION}/verify`,
      'GET http://bastion-api:4024/v1/ledger/seals',
      'GET http://bastion-api:4024/v1/ledger/restores',
    ]);
  });

  it('M4 lists thread cursor and limit to bastion-api (#204)', async () => {
    const tool = await load();
    await tool('bastion_list_evaluations').handler({ status: 'partial', cursor: 'c1', limit: 5 } as never);
    await tool('bastion_evidence_for').handler({ control_id: CTRL, cursor: 'c2', limit: 10 } as never);
    await tool('bastion_list_seals').handler({ cursor: 'c3', limit: 30 } as never);
    await tool('bastion_list_restores').handler({ cursor: 'c4', limit: 20 } as never);
    expect(calls.map((c) => c.url)).toEqual([
      'http://bastion-api:4024/v1/evaluations?status=partial&cursor=c1&limit=5',
      `http://bastion-api:4024/v1/controls/${CTRL}/evidence?cursor=c2&limit=10`,
      'http://bastion-api:4024/v1/ledger/seals?cursor=c3&limit=30',
      'http://bastion-api:4024/v1/ledger/restores?cursor=c4&limit=20',
    ]);
  });

  it('M4: resolving a ledger restore has no tool (owner integrity act behind a session)', async () => {
    await load();
    // (bastion_acknowledge_drift, M6, acknowledges a drift row, not a restore.)
    expect(captured.map((c) => c.name).join(' ')).not.toMatch(/acknowledge_restore|restore_ack|resolve/);
  });

  it('surfaces a bastion-api error as an MCP error result', async () => {
    captured.length = 0;
    const { registerBastionTools } = await import('../src/tools-pending/bastion.js');
    registerBastionTools({} as never, {} as never, 'http://b/v1', async () =>
      new Response(JSON.stringify({ error: { code: 'COMPILE_RUNNING' } }), { status: 409 }),
    );
    const t = captured.find((c) => c.name === 'bastion_compile_framework')!;
    const res = (await t.handler({ framework_id: FW } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('COMPILE_RUNNING');
  });
});

describe('Bastion #196 parity tools (setup and admin writes, room reads)', () => {
  const LINK = '44444444-4444-4444-8444-444444444444';
  const PROJECT = '55555555-5555-4555-8555-555555555555';
  const ROOM = '66666666-6666-4666-8666-666666666666';

  const parse = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text);

  it('bastion_compile_framework pages run history with cursor and limit', async () => {
    const tool = await load();
    await tool('bastion_compile_framework').handler({ framework_id: FW, action: 'list_runs', cursor: 'abc', limit: 10 } as never);
    expect(calls[0]!.url).toBe(`http://bastion-api:4024/v1/frameworks/${FW}/compile-runs?cursor=abc&limit=10`);
  });

  it('bastion_adopt_framework and bastion_update_framework call the framework routes', async () => {
    const tool = await load();
    await tool('bastion_adopt_framework').handler({ template_key: 'soc2', audit_target_date: '2027-03-31' } as never);
    await tool('bastion_update_framework').handler({ framework_id: FW, changes: { name: 'SOC 2 Type II' } } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://bastion-api:4024/v1/frameworks',
      `PATCH http://bastion-api:4024/v1/frameworks/${FW}`,
    ]);
    expect(calls[0]!.body).toEqual({ template_key: 'soc2', audit_target_date: '2027-03-31' });
    expect(calls[1]!.body).toEqual({ name: 'SOC 2 Type II' });
  });

  it('inputs are the shared Zod schemas (closed template list, strict changes)', async () => {
    const tool = await load();
    const tk = tool('bastion_adopt_framework').input.template_key as { safeParse: (v: unknown) => { success: boolean } };
    expect(tk.safeParse('soc2').success).toBe(true);
    expect(tk.safeParse('pci').success).toBe(false);
    const changes = tool('bastion_update_framework').input.changes as { safeParse: (v: unknown) => { success: boolean } };
    expect(changes.safeParse({}).success).toBe(false);
    expect(changes.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('bastion_archive_framework is two-step: staging calls nothing, the token archives once', async () => {
    const store = memoryTokenStore();
    const tool = await load(store);
    const staged = parse(await tool('bastion_archive_framework').handler({ framework_id: FW } as never));
    expect(staged.status).toBe('pending_confirmation');
    expect(calls).toEqual([]);
    expect(store.entries.get(staged.confirm_token)).toMatchObject({ action: 'bastion_archive_framework', resource_id: FW, ttlMs: 300_000 });

    // A token for another framework is refused and archives nothing.
    const wrong = (await tool('bastion_archive_framework').handler({
      framework_id: '77777777-7777-4777-8777-777777777777',
      confirm_token: staged.confirm_token,
    } as never)) as { isError?: boolean };
    expect(wrong.isError).toBe(true);
    expect(calls).toEqual([]);

    await tool('bastion_archive_framework').handler({ framework_id: FW, confirm_token: staged.confirm_token } as never);
    expect(calls).toEqual([{ url: `http://bastion-api:4024/v1/frameworks/${FW}/archive`, method: 'POST', body: { confirm: true } }]);
    // Single use.
    const again = (await tool('bastion_archive_framework').handler({ framework_id: FW, confirm_token: staged.confirm_token } as never)) as {
      isError?: boolean;
    };
    expect(again.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('bastion_archive_framework fails closed without a confirm-token store', async () => {
    const tool = await load(null);
    const res = (await tool('bastion_archive_framework').handler({ framework_id: FW } as never)) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('bastion_upsert_control creates or edits, never both', async () => {
    const tool = await load();
    await tool('bastion_upsert_control').handler({ create: { slug: 'radio-check', title: 'The radio is checked daily' } } as never);
    await tool('bastion_upsert_control').handler({ control_id: CTRL, changes: { risk_weight: 4 } } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://bastion-api:4024/v1/controls',
      `PATCH http://bastion-api:4024/v1/controls/${CTRL}`,
    ]);
    calls = [];
    const bad = (await tool('bastion_upsert_control').handler({
      create: { slug: 'x1', title: 'x' },
      control_id: CTRL,
    } as never)) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('bastion_decide_applicability decides in bulk or one link', async () => {
    const tool = await load();
    const decisions = [{ ref_code: 'A.7.1', applicability: 'not_applicable', not_applicable_reason: 'No server room' }];
    await tool('bastion_decide_applicability').handler({ framework_id: FW, decisions } as never);
    await tool('bastion_decide_applicability').handler({
      requirement_link_id: LINK,
      decision: { applicability: 'applicable' },
    } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST http://bastion-api:4024/v1/frameworks/${FW}/applicability`,
      `PATCH http://bastion-api:4024/v1/control-requirements/${LINK}`,
    ]);
    expect(calls[0]!.body).toEqual({ decisions });
    const schema = tool('bastion_decide_applicability').input.decision as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ applicability: 'not_applicable' }).success).toBe(false);
  });

  it('bastion_save_company_profile and bastion_set_compliance_project call the setup routes', async () => {
    const tool = await load();
    await tool('bastion_save_company_profile').handler({ profile: { company_size: '11-50', uses_github: true } } as never);
    await tool('bastion_set_compliance_project').handler({ project_id: PROJECT } as never);
    expect(calls).toEqual([
      { url: 'http://bastion-api:4024/v1/setup/profile', method: 'PATCH', body: { company_size: '11-50', uses_github: true } },
      { url: 'http://bastion-api:4024/v1/setup/compliance-project', method: 'POST', body: { project_id: PROJECT } },
    ]);
  });

  it('the room reads (spec rows 84, 88, 89) are GETs', async () => {
    const tool = await load();
    await tool('bastion_list_auditor_rooms').handler({} as never);
    await tool('bastion_list_auditor_rooms').handler({ room_id: ROOM } as never);
    await tool('bastion_list_auditor_requests').handler({ room_id: ROOM, status: 'open' } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://bastion-api:4024/v1/auditor-rooms',
      `GET http://bastion-api:4024/v1/auditor-rooms/${ROOM}/access-log`,
      `GET http://bastion-api:4024/v1/auditor-requests?room_id=${ROOM}&status=open`,
    ]);
  });
});

describe('Bastion M5 tools (manual evidence, feeds, coverage)', () => {
  const ME = '88888888-8888-4888-8888-888888888888';
  const FEED = '99999999-9999-4999-8999-999999999999';
  const parse = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text);

  it('bastion_list_manual_evidence lists with filters or reads one item', async () => {
    const tool = await load();
    await tool('bastion_list_manual_evidence').handler({ status: 'pending_scan', stuck: true, control_id: CTRL, limit: 20 } as never);
    await tool('bastion_list_manual_evidence').handler({ manual_evidence_id: ME } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET http://bastion-api:4024/v1/manual-evidence?status=pending_scan&control_id=${CTRL}&stuck=true&limit=20`,
      `GET http://bastion-api:4024/v1/manual-evidence/${ME}`,
    ]);
    const status = tool('bastion_list_manual_evidence').input.status as { safeParse: (v: unknown) => { success: boolean } };
    expect(status.safeParse('active').success).toBe(true);
    expect(status.safeParse('deleted').success).toBe(false);
  });

  it('link and unlink call the link routes; check-again posts to the item', async () => {
    const tool = await load();
    await tool('bastion_link_manual_evidence').handler({ manual_evidence_id: ME, assertion_id: ASSERTION } as never);
    await tool('bastion_unlink_manual_evidence').handler({ manual_evidence_id: ME, assertion_id: ASSERTION } as never);
    await tool('bastion_check_evidence_scan_again').handler({ manual_evidence_id: ME } as never);
    expect(calls).toEqual([
      { url: `http://bastion-api:4024/v1/manual-evidence/${ME}/links`, method: 'POST', body: { assertion_id: ASSERTION } },
      { url: `http://bastion-api:4024/v1/manual-evidence/${ME}/links/${ASSERTION}`, method: 'DELETE', body: undefined },
      { url: `http://bastion-api:4024/v1/manual-evidence/${ME}/check-again`, method: 'POST', body: {} },
    ]);
  });

  it('bastion_withdraw_manual_evidence is two-step and sends the confirm body once', async () => {
    const store = memoryTokenStore();
    const tool = await load(store);
    const staged = parse(await tool('bastion_withdraw_manual_evidence').handler({ manual_evidence_id: ME } as never));
    expect(staged.status).toBe('pending_confirmation');
    expect(calls).toEqual([]);
    expect(store.entries.get(staged.confirm_token)).toMatchObject({ action: 'bastion_withdraw_manual_evidence', resource_id: ME });

    const wrong = (await tool('bastion_withdraw_manual_evidence').handler({ manual_evidence_id: ASSERTION, confirm_token: staged.confirm_token } as never)) as {
      isError?: boolean;
    };
    expect(wrong.isError).toBe(true);
    expect(calls).toEqual([]);

    await tool('bastion_withdraw_manual_evidence').handler({ manual_evidence_id: ME, reason: 'Wrong export', confirm_token: staged.confirm_token } as never);
    expect(calls).toEqual([
      { url: `http://bastion-api:4024/v1/manual-evidence/${ME}/withdraw`, method: 'POST', body: { confirm: true, reason: 'Wrong export' } },
    ]);
    const again = (await tool('bastion_withdraw_manual_evidence').handler({ manual_evidence_id: ME, confirm_token: staged.confirm_token } as never)) as {
      isError?: boolean;
    };
    expect(again.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('bastion_withdraw_manual_evidence fails closed without a confirm-token store', async () => {
    const tool = await load(null);
    const res = (await tool('bastion_withdraw_manual_evidence').handler({ manual_evidence_id: ME } as never)) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('feeds: list, records, create and update', async () => {
    const tool = await load();
    await tool('bastion_list_feeds').handler({} as never);
    await tool('bastion_list_feed_records').handler({ feed_id: FEED, limit: 10, before: '2026-11-20T00:00:00Z' } as never);
    await tool('bastion_create_feed').handler({ feed: { feed_key: 'crew-roster', label: 'Crew roster export' } } as never);
    await tool('bastion_update_feed').handler({ feed_id: FEED, changes: { status: 'paused' } } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://bastion-api:4024/v1/feeds',
      `GET http://bastion-api:4024/v1/feeds/${FEED}/records?limit=10&before=2026-11-20T00%3A00%3A00Z`,
      'POST http://bastion-api:4024/v1/feeds',
      `PATCH http://bastion-api:4024/v1/feeds/${FEED}`,
    ]);
    expect(calls[2]!.body).toEqual({ feed_key: 'crew-roster', label: 'Crew roster export' });
    expect(calls[3]!.body).toEqual({ status: 'paused' });
    const feed = tool('bastion_create_feed').input.feed as { safeParse: (v: unknown) => { success: boolean } };
    expect(feed.safeParse({ feed_key: 'x', label: 'y' }).success).toBe(false);
    expect(feed.safeParse({ feed_key: 'events', label: 'E', source_kind: 'bolt_event' }).success).toBe(false);
  });

  it('bastion_coverage_summary reads the summary by default and the map on request', async () => {
    const tool = await load();
    await tool('bastion_coverage_summary').handler({} as never);
    await tool('bastion_coverage_summary').handler({ mode: 'map', framework_id: FW } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://bastion-api:4024/v1/summary',
      `GET http://bastion-api:4024/v1/coverage?framework_id=${FW}`,
    ]);
  });

  it('has no tool for uploading, reviewing, redacting, downloading or feed keys (sanctioned skips)', async () => {
    await load();
    const names = captured.map((c) => c.name).join(' ');
    expect(names).not.toMatch(/upload|supersede|review|redact|download|feed_key|push/);
  });
});

describe('Bastion M6 tools (gaps, fixes, exceptions, drift)', () => {
  const GAP = '66666666-6666-4666-8666-666666666666';
  const DRAFT = '77777777-7777-4777-8777-777777777777';
  const EXC = '88888888-8888-4888-8888-888888888888';
  const DRIFT = '99999999-9999-4999-8999-999999999999';
  const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('reads gaps, fix drafts, exceptions and drift on the right routes', async () => {
    const tool = await load();
    await tool('bastion_coverage_gaps').handler({ sort: 'quick_wins', limit: 5 } as never);
    await tool('bastion_list_fix_drafts').handler({ status: 'proposed' } as never);
    await tool('bastion_list_fix_drafts').handler({ fix_draft_id: DRAFT } as never);
    await tool('bastion_list_exceptions').handler({ control_id: CTRL } as never);
    await tool('bastion_list_exceptions').handler({ exception_id: EXC } as never);
    await tool('bastion_list_drift').handler({ unacknowledged: true } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://bastion-api:4024/v1/gaps?sort=quick_wins&limit=5',
      'GET http://bastion-api:4024/v1/fix-drafts?status=proposed',
      `GET http://bastion-api:4024/v1/fix-drafts/${DRAFT}`,
      `GET http://bastion-api:4024/v1/exceptions?control_id=${CTRL}`,
      `GET http://bastion-api:4024/v1/exceptions/${EXC}`,
      'GET http://bastion-api:4024/v1/drift?unacknowledged=true',
    ]);
  });

  it('proposes fixes and exceptions, dismisses gaps, marks fixes applied, acknowledges drift', async () => {
    const tool = await load();
    await tool('bastion_propose_fix').handler({ gap_id: GAP } as never);
    await tool('bastion_dismiss_gap').handler({ gap_id: GAP, reason: 'We have no laptops' } as never);
    await tool('bastion_mark_fix_applied').handler({ fix_draft_id: DRAFT, applied_entity_type: 'bolt.rule', applied_entity_id: KEY } as never);
    await tool('bastion_propose_exception').handler({
      control_id: CTRL,
      scope: 'entity',
      cited_entity_type: 'bam.api_key',
      cited_entity_id: KEY,
      reason: 'Radio Relay key rotated by hand',
      expires_on: '2027-06-30',
    } as never);
    await tool('bastion_acknowledge_drift').handler({ drift_id: DRIFT, note: 'Seen' } as never);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST http://bastion-api:4024/v1/gaps/${GAP}/propose-fix`,
      `POST http://bastion-api:4024/v1/gaps/${GAP}/dismiss`,
      `POST http://bastion-api:4024/v1/fix-drafts/${DRAFT}/mark-applied`,
      'POST http://bastion-api:4024/v1/exceptions',
      `POST http://bastion-api:4024/v1/drift/${DRIFT}/acknowledge`,
    ]);
    expect(calls[0]!.body).toEqual({ note: null });
    expect(calls[2]!.body).toEqual({ applied_entity_type: 'bolt.rule', applied_entity_id: KEY, note: null });
    expect(calls[3]!.body).toMatchObject({ scope: 'entity', cited_entity_id: KEY, expires_on: '2027-06-30' });
  });

  it('refuses an exception missing what it covers before calling bastion-api', async () => {
    const tool = await load();
    const r = (await tool('bastion_propose_exception').handler({ control_id: CTRL, scope: 'assertion', reason: 'x', expires_on: '2027-01-01' } as never)) as {
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('has no tool for either decide route: auth, session required (spec 2.8, #136)', async () => {
    await load();
    const names = captured.map((c) => c.name).join(' ');
    // (bastion_decide_applicability is the setup applicability decision, not a vouching route.)
    expect(names).not.toMatch(/decide_fix|decide_exception|fix_decide|exception_decide|approve/);
    expect(PENDING).not.toMatch(/fix-drafts\/\$\{[^}]+\}\/decide|exceptions\/\$\{[^}]+\}\/decide/);
  });
});
