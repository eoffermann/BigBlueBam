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

async function load() {
  captured.length = 0;
  const { registerBastionTools } = await import('../src/tools-pending/bastion.js');
  const api = { token: 'bbam_test' } as never;
  registerBastionTools({} as never, api, 'http://bastion-api:4024/v1/', fakeFetch);
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
    expect((PENDING.match(/registerTool\(server, \{/g) ?? []).length).toBe(7);
    expect(PENDING).not.toMatch(/server\.tool\(/);
  });
});

describe('Bastion M3 tool handlers', () => {
  it('registers exactly the M3 roster', async () => {
    await load();
    const { BASTION_PENDING_TOOL_NAMES } = await import('../src/tools-pending/bastion.js');
    expect(captured.map((c) => c.name).sort()).toEqual([...BASTION_PENDING_TOOL_NAMES].sort());
  });

  it('has no tool for any human gate (confirm, reject, adopt, archive, applicability, setup writes)', async () => {
    await load();
    const names = captured.map((c) => c.name).join(' ');
    expect(names).not.toMatch(/confirm|reject|adopt|archive|applicab|profile|compliance_project/);
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
