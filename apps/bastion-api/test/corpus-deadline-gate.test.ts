import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmDeadlineMs } from '../src/library/llm-call-settings.js';
import { callLlmProxy, CORPUS_DEADLINE_HEADROOM, completionTokens, deadlineGate, recordingDeadlineMeta, TIMING_RECORDED_SINCE } from './corpus/llm-recording.js';

// #317: the corpus gates check recorded (and live) LLM calls against the production deadline.

const NOW = '2026-12-01T00:00:00.000Z';
const answer = (ms: number, tokens: number | null = 1000) => ({ content: '{}', finish_reason: 'stop', ms, completion_tokens: tokens });

describe('deadlineGate (#317)', () => {
  it('the issue case: 70 s answers recorded through a 90 s forwarder fail against the 60 s production deadline', () => {
    const corpus = { meta: { recorded_at: NOW, llm_kind: 'compile' as const, deadline_ms: 90_000 }, responses: { a: answer(70_000), b: answer(12_000) } };
    const g = deadlineGate(corpus, 'compile', 60_000);
    expect(g.violations.some((v) => v.includes('longer than the 60000 ms production uses'))).toBe(true);
    expect(g.violations.some((v) => v.startsWith('compile: a took 70000 ms'))).toBe(true);
    // The operator is told what to change, and how fast the model was.
    expect(g.violations.find((v) => v.includes('a took'))).toMatch(/14\.3 tokens\/s; raise BASTION_LLM_TIMEOUT_MS or lower BASTION_LLM_MAX_TOKENS/);
  });

  it(`fails a call over ${CORPUS_DEADLINE_HEADROOM * 100}% of the deadline even when the deadlines agree, and passes one under it`, () => {
    const meta = { recorded_at: NOW, ...recordingDeadlineMeta('questionnaire_draft', {}) };
    const budget = llmDeadlineMs('questionnaire_draft', {}) * CORPUS_DEADLINE_HEADROOM;
    expect(deadlineGate({ meta, responses: { q1: answer(budget + 1) } }, 'questionnaire_draft', llmDeadlineMs('questionnaire_draft', {})).violations).toHaveLength(1);
    const ok = deadlineGate({ meta, responses: { q1: answer(budget - 1, null) } }, 'questionnaire_draft', llmDeadlineMs('questionnaire_draft', {}));
    expect(ok.violations).toEqual([]);
    expect(ok.timed).toBe(1);
    expect(ok.report[0]).toContain('? tokens/s');
  });

  it('a timed-out call fails; the fix_reword deadline is its own, shorter one', () => {
    const meta = { recorded_at: NOW, ...recordingDeadlineMeta('fix_reword', {}) };
    expect(meta.deadline_ms).toBe(25_000);
    const g = deadlineGate({ meta, responses: { r1: { error: 'The operation was aborted due to timeout', ms: 1_000 } } }, 'fix_reword', 25_000);
    expect(g.violations[0]).toMatch(/r1 timed out.*raise the fix_reword deadline in llm-call-settings\.ts or lower BASTION_REWORD_MAX_TOKENS/);
  });

  it('a recording made after timing existed must carry it; one made before is reported, not passed silently', () => {
    const untimed = { meta: { recorded_at: NOW }, responses: { a: { content: '{}', finish_reason: 'stop' } } };
    expect(deadlineGate(untimed, 'compile', 60_000).violations.length).toBeGreaterThan(0);
    const legacy = { meta: { recorded_at: '2026-11-26T16:11:33.377Z' }, responses: { a: { content: '{}', finish_reason: 'stop' } } };
    expect(legacy.meta.recorded_at < TIMING_RECORDED_SINCE).toBe(true);
    const g = deadlineGate(legacy, 'compile', 60_000);
    expect(g).toMatchObject({ violations: [], untimedLegacy: true, timed: 0 });
    expect(g.report[0]).toContain('without per-call timing');
  });
});

describe('callLlmProxy records time and completion tokens (#317)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads OpenAI and Anthropic usage, and sends the kind production deadline and budget', async () => {
    expect(completionTokens({ completion_tokens: 812, prompt_tokens: 3 })).toBe(812);
    expect(completionTokens({ output_tokens: 90, input_tokens: 3 })).toBe(90);
    expect(completionTokens(null)).toBeNull();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ data: { content: 'x', finish_reason: 'stop', usage: { completion_tokens: 40 } } }), { status: 200 }));
    const r = await callLlmProxy({ api: 'http://api', providerId: 'p', secret: 's' }, 'compile', [{ role: 'user', content: 'hi' }], {});
    expect(r).toMatchObject({ content: 'x', finish_reason: 'stop', completion_tokens: 40 });
    expect(typeof r.ms).toBe('number');
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(sent).toMatchObject({ provider_id: 'p', timeout_ms: llmDeadlineMs('compile', {}), max_tokens: 8192, temperature: 0 });
  });
});
