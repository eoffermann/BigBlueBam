import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS = readFileSync(
  join(__dirname, '..', 'src', 'tools', 'burn-tools.ts'),
  'utf8',
);
const SERVER = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
const ENV = readFileSync(join(__dirname, '..', 'src', 'env.ts'), 'utf8');

function toolNames(): string[] {
  return [...TOOLS.matchAll(/name: '(burn_[a-z_]+)'/g)].map((m) => m[1]!);
}

/**
 * The `input: { ... }` schema block for one tool.
 *
 * Assertions about what a tool CANNOT accept must run against its input schema, not against
 * its whole source. Every one of these tools DESCRIBES its own boundary in prose -- that is
 * how the calling model learns the rule -- so a whole-file substring assertion fails on the
 * description that documents the boundary rather than on a field that breaches it, and the
 * quickest way to make it pass would be to delete the very sentence that stops an agent
 * trying. Slicing to the schema keeps both halves honest, and each block below pairs the
 * schema assertion with one that requires the prose to still be present.
 */
function toolInput(name: string): string {
  const start = TOOLS.indexOf(`name: '${name}'`);
  if (start === -1) throw new Error(`tool ${name} not found`);
  const inputIdx = TOOLS.indexOf('input: {', start);
  const returnsIdx = TOOLS.indexOf('returns:', inputIdx);
  return TOOLS.slice(inputIdx, returnsIdx);
}

/* ══════════════════════════════════════════════════════════════════════════════════════
   Spec 12.1 / 11.1. The MCP surface.
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe('the Burn tool roster matches spec 11.1', () => {
  const EXPECTED = [
    'burn_precheck',
    'burn_attribute',
    'burn_financials',
    'burn_margin', // the deprecated alias
    'burn_list_engagements',
    'burn_get_engagement',
    'burn_extract_deliverables',
    'burn_delete_engagement',
    'burn_list_deliverables',
    'burn_confirm_deliverable',
    'burn_reject_deliverable',
    'burn_list_unscoped',
    'burn_reclassify_attribution',
    'burn_override_precheck',
    'burn_list_variances',
    'burn_draft_change_order',
    'burn_set_gate_mode',
    'burn_calibration_report',
  ];

  it('registers exactly 17 tools plus the one deprecated alias', () => {
    expect(toolNames().sort()).toEqual([...EXPECTED].sort());
    expect(toolNames().length).toBe(18);
    expect(toolNames().filter((n) => n !== 'burn_margin').length).toBe(17);
  });

  it('every tool goes through registerTool, which is what enforces agent_policies', () => {
    // registerTool's PolicyGate applies the section 15 kill switch and the
    // matchesAllowlist('burn.*') check on every service-account invocation. A hand-registered
    // server.tool(...) would bypass both, and burn_* would then be callable by a disabled
    // agent.
    const registerToolCalls = TOOLS.match(/registerTool\(server, \{/g) ?? [];
    expect(registerToolCalls.length).toBe(toolNames().length);
    expect(TOOLS).not.toMatch(/server\.tool\(/);
    expect(TOOLS).not.toMatch(/server\.registerTool\(/);
  });

  it('is wired into the mcp-server bootstrap', () => {
    expect(SERVER).toContain("import { registerBurnTools } from './tools/burn-tools.js';");
    expect(SERVER).toContain('registerBurnTools(server, apiClient, env.BURN_API_URL, confirmTokenStore);');
  });

  it('reads BURN_API_URL from env with the compose-internal default', () => {
    expect(ENV).toContain("BURN_API_URL: z.string().url().default('http://burn-api:4022/v1')");
  });
});

describe('envelope confirmation is not agent-reachable (2.2.1)', () => {
  it('no tool CALLS the confirm-envelope or bulk-confirm-unpriced endpoints', () => {
    // This is a SECURITY BOUNDARY, not a gap in the surface. Do not "complete" it.
    // Asserted on request paths, since the header comment legitimately names both routes in
    // order to say they are off limits.
    const requestPaths = [...TOOLS.matchAll(/client\.request\(\s*'[A-Z]+',\s*`([^`]+)`/g)].map(
      (m) => m[1]!,
    );
    for (const path of requestPaths) {
      expect(path).not.toContain('confirm-envelope');
      expect(path).not.toContain('bulk-confirm-unpriced');
    }
    expect(toolNames()).not.toContain('burn_confirm_envelope');
  });

  it('burn_confirm_deliverable cannot carry an envelope or is_active field', () => {
    const input = toolInput('burn_confirm_deliverable');
    expect(input).not.toContain('envelope_amount');
    expect(input).not.toContain('is_active');
    expect(input).not.toContain('envelope_source');
    // And its review_status enum omits `rejected`, so the destructive transition can only
    // happen through the confirm-gated burn_reject_deliverable.
    expect(input).toContain("review_status: z.enum(['pending_review', 'confirmed', 'superseded'])");
  });

  it('and the boundary is DOCUMENTED in the description the model reads', () => {
    const tool = TOOLS.slice(
      TOOLS.indexOf("name: 'burn_confirm_deliverable'"),
      TOOLS.indexOf("name: 'burn_reject_deliverable'"),
    );
    expect(tool).toMatch(/CANNOT SET THE ENVELOPE/i);
  });
});

describe('confirm_action boundaries (2.5)', () => {
  it('the two destructive tools take a confirm_token', () => {
    for (const name of ['burn_delete_engagement', 'burn_reject_deliverable']) {
      const idx = TOOLS.indexOf(`name: '${name}'`);
      expect(idx, `${name} missing`).toBeGreaterThan(-1);
      const tool = TOOLS.slice(idx, idx + 3000);
      expect(tool).toContain('confirm_token');
      expect(tool).toContain('confirmTokenStore.set');
      expect(tool).toContain('confirmTokenStore.delete');
    }
  });

  it('burn_set_gate_mode requires a token when the target WEAKENS enforcement', () => {
    // The direction that needs the token is switching the spend control OFF, not on.
    // Promoting to blocking is separately gated by the seven server-side preconditions.
    expect(TOOLS).toContain('function weakensEnforcement');
    const fn = TOOLS.slice(
      TOOLS.indexOf('function weakensEnforcement'),
      TOOLS.indexOf('export function registerBurnTools'),
    );
    expect(fn).toContain("args.gate_mode === 'off'");
    expect(fn).toContain("args.gate_mode === 'advisory'");
    expect(fn).toContain('args.gate_paused_until');
    expect(fn).not.toContain("=== 'blocking'");

    const tool = TOOLS.slice(TOOLS.indexOf("name: 'burn_set_gate_mode'"));
    expect(tool).toContain('weakening && !confirm_token');
    expect(tool).toContain('weakening && confirm_token');
  });

  it('burn_draft_change_order deliberately takes NO confirm token', () => {
    // The draft becomes an agent_proposals row, and that queue IS the confirmation step.
    // A second token would be ceremony rather than control. Asserted on the input schema:
    // the description says WHY there is no token, and that sentence should survive.
    expect(toolInput('burn_draft_change_order')).not.toContain('confirm_token');
    const tool = TOOLS.slice(
      TOOLS.indexOf("name: 'burn_draft_change_order'"),
      TOOLS.indexOf("name: 'burn_set_gate_mode'"),
    );
    expect(tool).toMatch(/NEVER SENT/i);
  });
});

describe('asker_user_id narrows both rows AND financial flooring (R3-S2)', () => {
  const MONEY_TOOLS = [
    'burn_precheck',
    'burn_financials',
    'burn_margin',
    'burn_get_engagement',
    'burn_list_unscoped',
    'burn_list_deliverables',
  ];

  for (const name of MONEY_TOOLS) {
    it(`${name} accepts and forwards asker_user_id`, () => {
      const idx = TOOLS.indexOf(`name: '${name}'`);
      const tool = TOOLS.slice(idx, idx + 3500);
      expect(tool).toContain('asker_user_id');
    });
  }

  it('the asker input describes the intersection rule rather than just visibility', () => {
    // On every other satellite asker_user_id narrows rows. On Burn it ALSO narrows flooring,
    // because burn-api intersects the bearer's and the asker's capabilities. An agent that
    // does not know this will omit the parameter and receive unfloored cost figures.
    const desc = TOOLS.slice(TOOLS.indexOf('const askerInput'), TOOLS.indexOf('const BURN_CONFIRM_TTL_MS'));
    expect(desc).toMatch(/intersection/i);
    expect(desc).toMatch(/flooring|cost/i);
  });
});

describe('the deprecated alias does not relabel consumption as margin (1.2.2)', () => {
  it('burn_margin returns the identical discriminated response', () => {
    const alias = TOOLS.slice(
      TOOLS.indexOf("name: 'burn_margin'"),
      TOOLS.indexOf("name: 'burn_list_engagements'"),
    );
    // No synthesized margin key, no post-processing: it hits the same endpoints.
    expect(alias).toContain('/financials/accounts');
    expect(alias).toContain('/financials');
    expect(alias).not.toMatch(/margin_amount\s*[:=]/);
    expect(alias.toLowerCase()).toContain('deprecated');
  });

  it('burn_financials tells the caller to read the discriminator first', () => {
    const tool = TOOLS.slice(
      TOOLS.indexOf("name: 'burn_financials'"),
      TOOLS.indexOf("name: 'burn_margin'"),
    );
    expect(tool).toContain('metric_basis');
    expect(tool).toMatch(/contract_consumption/);
    expect(tool).toMatch(/suppressed/);
  });
});

describe('burn_* is not in EXPLICIT_TOOL_OVERRIDES, so burn.* gates via the allowlist', () => {
  it('no burn_ entry exists in the override map', () => {
    const registerTool = readFileSync(
      join(__dirname, '..', 'src', 'lib', 'register-tool.ts'),
      'utf8',
    );
    const overridesIdx = registerTool.indexOf('EXPLICIT_TOOL_OVERRIDES');
    if (overridesIdx === -1) return; // map lives elsewhere; the allowlist path still applies
    const block = registerTool.slice(overridesIdx, overridesIdx + 4000);
    expect(block).not.toMatch(/'burn_/);
  });

  it('every tool name is burn_<verb>_<noun> so one burn.* glob gates them all', () => {
    for (const name of toolNames()) {
      expect(name.startsWith('burn_')).toBe(true);
    }
  });
});
