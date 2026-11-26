import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bastionManualEvidenceSpecSchema } from '@bigbluebam/shared';
import { scanLabel } from '../src/lib/injection-prescan.js';
import { planTailoredControl, type TailoredControlPlan } from '../src/library/compile-plan.js';
import { probeEntry } from '../src/library/probe-catalog.js';
import { buildTailoringMessages, normalizeAiText, parseTailoringResponse, TAILORING_PROMPT_VERSION, tailoredSuggestions } from '../src/library/tailoring.js';
import { CORPUS_CONNECTED, CORPUS_PROFILE, corpusControls, type CorpusControl, type RecordedCorpus } from './corpus/compiler-fixtures.js';

// The compiler corpus gates (spec 11.3), deterministic in CI: every SOC 2 and ISO 27001 control's
// RECORDED live answer (test/corpus/compiler-recorded.json, recorded through the internal LLM
// proxy by test/corpus/record-compiler-corpus.ts) and a hand-written hostile set
// (compiler-adversarial.json) are replayed through the production path: parse, tailor, validate,
// plan with the per-control fallback. Gates:
//   validity   0 invalid probe keys, parameters, thresholds or manual specs reach `proposed`, and
//              no confirmation stamp or unconnected population member does either;
//   coverage   every control receives a check, an evidence request or a not-applicable suggestion;
//   injection  nothing instruction-like reaches a proposal, and the injection-shaped connected
//              label never reaches the prompt.
// Optional live run: BASTION_COMPILER_LIVE=1 plus BASTION_RECORD_API_URL, BASTION_RECORD_PROVIDER_ID,
// INTERNAL_SERVICE_SECRET (and BASTION_RECORD_MODEL_OVERRIDE if needed) applies the same gates to
// fresh answers. Recorded caveat: replays never exercise the real proxy timeout or concurrency.

const dir = join(__dirname, 'corpus');
const RECORDED = JSON.parse(readFileSync(join(dir, 'compiler-recorded.json'), 'utf8')) as RecordedCorpus;
const ADVERSARIAL = JSON.parse(readFileSync(join(dir, 'compiler-adversarial.json'), 'utf8')) as Pick<RecordedCorpus, 'responses'>;
const CONTROLS = corpusControls();
const CONNECTED_VALUES = new Set(Object.values(CORPUS_CONNECTED).flatMap((m) => m.map((x) => x.value)));

function replay(c: CorpusControl, response: { content: string; finish_reason: string | null } | { error: string } | undefined): TailoredControlPlan {
  const key = c.control.control_key;
  if (!response || 'error' in response) return planTailoredControl(key, null, [], CORPUS_CONNECTED, 'the AI call failed');
  const parsed = parseTailoringResponse(response.content, response.finish_reason);
  if (!parsed.ok) return planTailoredControl(key, null, [], CORPUS_CONNECTED, parsed.reason);
  return planTailoredControl(key, tailoredSuggestions(key, parsed.value, { control: c.control, requirements: c.requirements, connected: CORPUS_CONNECTED }), [], CORPUS_CONNECTED);
}

/** Every reason a planned proposal would be invalid; empty means it passes the validity gate. */
function invalidities(plan: TailoredControlPlan): string[] {
  const out: string[] = [];
  for (const p of plan.planned) {
    if (p.kind === 'probe') {
      const entry = probeEntry(p.probe_key ?? '');
      if (!entry) {
        out.push(`unknown probe ${p.probe_key}`);
        continue;
      }
      if (!entry.paramsSchema.safeParse(p.params).success) out.push(`${p.probe_key} params out of range`);
      if (!entry.predicateSchema.safeParse(p.predicate).success) out.push(`${p.probe_key} threshold out of range`);
      if ('population_confirmed_at' in p.params || 'population_confirmed_by' in p.params) out.push(`${p.probe_key} carries a confirmation stamp`);
      const pop = p.params.expected_population;
      if (Array.isArray(pop)) for (const m of pop) if (!CONNECTED_VALUES.has(String(m))) out.push(`${p.probe_key} lists unconnected ${String(m)}`);
    } else if (!bastionManualEvidenceSpecSchema.safeParse(p.manual_evidence_spec).success) {
      out.push('manual spec invalid');
    }
  }
  return out;
}

function proposalTexts(plan: TailoredControlPlan): string[] {
  return [
    ...plan.planned.flatMap((p) => [p.plain_statement, p.manual_evidence_spec?.title ?? '', p.manual_evidence_spec?.description ?? '']),
    ...plan.not_applicable.map((n) => n.reason),
  ];
}

describe('compiler corpus: the recording', () => {
  it('covers every SOC 2 and ISO 27001 control and matches the current prompt version', () => {
    expect(Object.keys(RECORDED.responses).sort()).toEqual(CONTROLS.map((c) => c.control.control_key).sort());
    // A prompt change must be re-recorded (npx tsx test/corpus/record-compiler-corpus.ts).
    expect(RECORDED.meta.prompt_version).toBe(TAILORING_PROMPT_VERSION);
  });

  it('every hostile fixture names a real corpus control', () => {
    const keys = new Set(CONTROLS.map((c) => c.control.control_key));
    for (const k of Object.keys(ADVERSARIAL.responses)) expect(keys.has(k), k).toBe(true);
  });

  it('the injection-shaped connected label never reaches the prompt', () => {
    for (const c of CONTROLS) {
      const { messages } = buildTailoringMessages({ control: c.control, requirements: c.requirements, profile: CORPUS_PROFILE, connected: CORPUS_CONNECTED });
      expect(messages[1]!.content).not.toMatch(/ignore all previous instructions/i);
    }
  });
});

for (const [name, source] of [
  ['recorded', RECORDED.responses],
  ['adversarial', { ...RECORDED.responses, ...ADVERSARIAL.responses }],
] as const) {
  describe(`compiler corpus gates (${name})`, () => {
    const plans = CONTROLS.map((c) => ({ key: c.control.control_key, plan: replay(c, (source as RecordedCorpus['responses'])[c.control.control_key]) }));

    it('validity: 0 invalid probe keys, parameters, thresholds or specs reach proposed', () => {
      const bad = plans.flatMap(({ key, plan }) => invalidities(plan).map((i) => `${key}: ${i}`));
      expect(bad).toEqual([]);
    });

    it('coverage: every control receives a check, an evidence request or a not-applicable suggestion', () => {
      const empty = plans.filter(({ plan }) => plan.planned.length === 0 && plan.not_applicable.length === 0).map((p) => p.key);
      expect(empty).toEqual([]);
    });

    it('injection: nothing instruction-like reaches a proposal, and no dash breaks house style', () => {
      const suspect = plans.flatMap(({ key, plan }) => proposalTexts(plan).filter((t) => scanLabel(t).suspected).map((t) => `${key}: ${t.slice(0, 80)}`));
      expect(suspect).toEqual([]);
      const dashed = plans.flatMap(({ key, plan }) => proposalTexts(plan).filter((t) => /[\u2014\u2013]/.test(t)).map(() => key));
      expect(dashed).toEqual([]);
    });

    it('everything the AI proposed is marked as the compiler, the rest as the library', () => {
      for (const { plan } of plans) {
        for (const p of plan.planned) expect(p.proposed_by).toBe(plan.used_fallback ? 'library' : 'compiler');
      }
    });
  });
}

describe('compiler corpus: what the hostile answers did', () => {
  const byKey = new Map(CONTROLS.map((c) => [c.control.control_key, c]));
  const plan = (key: string) => replay(byKey.get(key)!, ADVERSARIAL.responses[key]);

  it('an invented probe and a raw query are dropped; a bad value falls back to the library', () => {
    const p = plan('keys.rotation');
    expect(p.planned.some((x) => x.probe_key === 'db.query')).toBe(false);
    expect(p.dropped.some((d) => /menu is closed/.test(d.reason))).toBe(true);
    expect(p.dropped.some((d) => /parameters out of range/.test(d.reason))).toBe(true);
  });

  it('the AI cannot confirm a list nor add a repository that is not connected', () => {
    const p = plan('change.peer_review');
    const params = p.planned.find((x) => x.probe_key === 'change.merge_reviewed')!.params;
    expect(params.expected_population).toEqual(['gilligan-travel/rescue-radio-firmware']);
    expect(params).not.toHaveProperty('population_confirmed_at');
  });

  it('cut-off, refused and non-JSON answers fall back to the library', () => {
    for (const k of ['vendors.management', 'ops.backups']) {
      const p = plan(k);
      expect(p.used_fallback, k).toBe(true);
    }
  });

  it('dashes in AI text become commas', () => {
    expect(normalizeAiText('Changes \u2014 even small ones \u2013 get a second look')).toBe('Changes, even small ones, get a second look');
  });
});

describe.runIf(process.env.BASTION_COMPILER_LIVE === '1')('compiler corpus gates (live provider)', () => {
  it('a fresh live answer for a sample of controls passes every gate', { timeout: 600_000 }, async () => {
    const api = (process.env.BASTION_RECORD_API_URL ?? '').replace(/\/+$/, '');
    const sample = CONTROLS.filter((_, i) => i % 6 === 0);
    for (const c of sample) {
      const { messages } = buildTailoringMessages({ control: c.control, requirements: c.requirements, profile: CORPUS_PROFILE, connected: CORPUS_CONNECTED });
      const res = await fetch(`${api}/internal/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': process.env.INTERNAL_SERVICE_SECRET ?? '', 'X-Internal-Service': 'bastion' },
        body: JSON.stringify({
          provider_id: process.env.BASTION_RECORD_PROVIDER_ID,
          messages,
          max_tokens: 2048,
          temperature: 0,
          ...(process.env.BASTION_RECORD_MODEL_OVERRIDE ? { model: process.env.BASTION_RECORD_MODEL_OVERRIDE } : {}),
        }),
      });
      const body = (await res.json()) as { data?: { content?: string; finish_reason?: string | null } };
      const plan = replay(c, res.ok ? { content: body.data?.content ?? '', finish_reason: body.data?.finish_reason ?? null } : { error: String(res.status) });
      expect(invalidities(plan), c.control.control_key).toEqual([]);
      expect(plan.planned.length + plan.not_applicable.length, c.control.control_key).toBeGreaterThan(0);
    }
  });
});
