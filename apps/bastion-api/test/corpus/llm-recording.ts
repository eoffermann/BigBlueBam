// The ONE way the corpus recorders and the live corpus gates call the internal LLM proxy (#317), and
// the ONE check that a recorded or live call fits inside the production deadline.
//
// Before #317 the same proxy call was written out four times (two recorders, two live gates), and
// the recordings stored no timing, so a model that answered in 70 s passed recording and the gates,
// then timed out in production at 60 s and fell back to library suggestions. Every call made here
// stores how long it took and how many completion tokens it produced; every recording stores the
// deadline it was made against; deadlineGate fails a call that used more than
// CORPUS_DEADLINE_HEADROOM of that deadline, and a recording made against a longer deadline than
// production uses.

import { LLM_CLIENT_GRACE_MS } from '@bigbluebam/shared';
import { type BastionLlmCallKind, BASTION_LLM_CALLS, llmDeadlineMs, llmMaxTokens } from '../../src/library/llm-call-settings.js';

/** A recorded call may use at most this share of the deadline it was recorded against. */
export const CORPUS_DEADLINE_HEADROOM = 0.8;

/**
 * Recordings made from this instant on store per-call timing (the recorder writes recorded_at), so
 * a recording newer than this without timing is refused. The committed recordings of 2026-11-26
 * predate it and carry no timing: deadlineGate reports them as not timed until they are re-recorded.
 */
export const TIMING_RECORDED_SINCE = '2026-11-27T00:00:00.000Z';

export interface RecordedAnswer {
  content: string;
  finish_reason: string | null;
  /** Wall time of the answered attempt, in ms (#317). */
  ms?: number;
  /** Completion (output) tokens the provider reported, when it reported them (#317). */
  completion_tokens?: number | null;
}
export type RecordedResponse = RecordedAnswer | { error: string; ms?: number };

/** The timing facts every recording's meta carries (#317). */
export interface RecordingDeadlineMeta {
  /** The call kind (llm-call-settings.ts) whose deadline and budget the recording used. */
  llm_kind?: BastionLlmCallKind;
  /** The deadline the recording was made against: llmDeadlineMs(kind, env) at recording time. */
  deadline_ms?: number;
}

/** Completion tokens from the proxy's `usage` (OpenAI `completion_tokens`, Anthropic `output_tokens`). */
export function completionTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = u.completion_tokens ?? u.output_tokens;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export interface ProxyTarget {
  api: string;
  providerId: string;
  secret: string;
  modelOverride?: string;
}

/** The proxy target from the recorder environment, or null when it is not set. */
export function proxyTargetFromEnv(env: Record<string, string | undefined> = process.env): ProxyTarget | null {
  const api = (env.BASTION_RECORD_API_URL ?? '').replace(/\/+$/, '');
  const providerId = env.BASTION_RECORD_PROVIDER_ID ?? '';
  const secret = env.INTERNAL_SERVICE_SECRET ?? '';
  if (!api || !providerId || !secret) return null;
  return { api, providerId, secret, modelOverride: env.BASTION_RECORD_MODEL_OVERRIDE || undefined };
}

/**
 * One call of `kind` through POST /internal/llm/chat, exactly as bastion-api makes it (the kind's
 * production max_tokens and deadline, X-Internal-Service: bastion, temperature 0). Retries a 429
 * with backoff; `ms` is the wall time of the attempt that was answered, the one the deadline
 * applies to. Never throws: a failure is `{ error, ms }`.
 */
export async function callLlmProxy(
  target: ProxyTarget,
  kind: BastionLlmCallKind,
  messages: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<RecordedResponse> {
  const deadline = llmDeadlineMs(kind, env);
  for (let attempt = 1; ; attempt++) {
    const t = Date.now();
    try {
      const res = await fetch(`${target.api}/internal/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': target.secret, 'X-Internal-Service': 'bastion' },
        body: JSON.stringify({
          provider_id: target.providerId,
          messages,
          max_tokens: llmMaxTokens(kind, env),
          temperature: 0,
          timeout_ms: deadline,
          // The proxy's optional `model` field (same provider key), for a provider row whose model is retired.
          ...(target.modelOverride ? { model: target.modelOverride } : {}),
        }),
        signal: AbortSignal.timeout(deadline + LLM_CLIENT_GRACE_MS),
      });
      if (res.status === 429 && attempt < 10) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      if (!res.ok) return { error: `proxy returned ${res.status}: ${(await res.text()).slice(0, 200)}`, ms: Date.now() - t };
      const body = (await res.json()) as { data?: { content?: string; finish_reason?: string | null; usage?: unknown } };
      const ms = Date.now() - t;
      return { content: body.data?.content ?? '', finish_reason: body.data?.finish_reason ?? null, ms, completion_tokens: completionTokens(body.data?.usage) };
    } catch (err) {
      return { error: (err as Error).message, ms: Date.now() - t };
    }
  }
}

/** The meta every recording of `kind` stores about its deadline. */
export function recordingDeadlineMeta(kind: BastionLlmCallKind, env: Record<string, string | undefined> = process.env): Required<RecordingDeadlineMeta> {
  return { llm_kind: kind, deadline_ms: llmDeadlineMs(kind, env) };
}

export interface DeadlineGateResult {
  /** One line per failure; empty when the gate passes. */
  violations: string[];
  /** The tokens-per-second report, slowest calls first, for the operator. */
  report: string[];
  /** How many calls carried timing. */
  timed: number;
  /** True when the recording predates timing (TIMING_RECORDED_SINCE) and could not be checked. */
  untimedLegacy: boolean;
}

/**
 * The #317 gate. `productionDeadlineMs` is the deadline production applies to this kind
 * (llmDeadlineMs(kind, process.env) where the gate runs). Fails when:
 *   - a timed recording was made against a longer deadline than production uses (it proves nothing);
 *   - any call took more than CORPUS_DEADLINE_HEADROOM of the recording's deadline, or timed out;
 *   - a recording made on or after TIMING_RECORDED_SINCE carries no timing.
 * The report prints each call's time and completion tokens per second, so an operator sees whether
 * to raise BASTION_LLM_TIMEOUT_MS or lower the kind's max_tokens variable.
 */
export function deadlineGate(
  corpus: { meta: RecordingDeadlineMeta & { recorded_at?: string }; responses: Record<string, RecordedResponse> },
  kind: BastionLlmCallKind,
  productionDeadlineMs: number,
): DeadlineGateResult {
  const violations: string[] = [];
  const entries = Object.entries(corpus.responses);
  const timedEntries = entries.filter(([, r]) => typeof r.ms === 'number');
  const recordedDeadline = corpus.meta.deadline_ms;
  const s = BASTION_LLM_CALLS[kind];
  const knobs = `raise ${s.deadlineEnv ?? `the ${kind} deadline in llm-call-settings.ts`} or lower ${s.maxTokensEnv}`;

  const legacy = timedEntries.length === 0 && recordedDeadline === undefined && (corpus.meta.recorded_at ?? '') < TIMING_RECORDED_SINCE;
  if (legacy) return { violations, report: [`${kind}: recorded ${corpus.meta.recorded_at} without per-call timing; re-record to time it`], timed: 0, untimedLegacy: true };

  if (recordedDeadline === undefined) violations.push(`${kind}: the recording has no meta.deadline_ms; re-record with the current recorder`);
  if (corpus.meta.llm_kind !== undefined && corpus.meta.llm_kind !== kind) violations.push(`${kind}: the recording was made as kind ${corpus.meta.llm_kind}`);
  if (recordedDeadline !== undefined && recordedDeadline > productionDeadlineMs) {
    violations.push(`${kind}: recorded against a ${recordedDeadline} ms deadline, longer than the ${productionDeadlineMs} ms production uses; re-record at the production deadline`);
  }
  const untimed = entries.filter(([, r]) => typeof r.ms !== 'number').map(([k]) => k);
  if (untimed.length > 0) violations.push(`${kind}: ${untimed.length} call(s) carry no timing: ${untimed.slice(0, 5).join(', ')}`);

  const budget = Math.floor(Math.min(recordedDeadline ?? productionDeadlineMs, productionDeadlineMs) * CORPUS_DEADLINE_HEADROOM);
  const rows = timedEntries
    .map(([k, r]) => {
      const ms = r.ms as number;
      const tokens = 'completion_tokens' in r ? (r.completion_tokens ?? null) : null;
      const tps = tokens !== null && ms > 0 ? tokens / (ms / 1000) : null;
      return { k, ms, tokens, tps, error: 'error' in r ? r.error : null };
    })
    .sort((a, b) => b.ms - a.ms);
  for (const r of rows) {
    if (r.ms > budget) violations.push(`${kind}: ${r.k} took ${r.ms} ms, over ${Math.round(CORPUS_DEADLINE_HEADROOM * 100)}% of the deadline (${budget} ms)${r.tps !== null ? ` at ${r.tps.toFixed(1)} tokens/s` : ''}; ${knobs}`);
    else if (r.error && /timed? ?out|timeout|504/i.test(r.error)) violations.push(`${kind}: ${r.k} timed out (${r.error.slice(0, 80)}); ${knobs}`);
  }
  const report = rows.slice(0, 5).map((r) => `${kind}: ${r.k} ${r.ms} ms, ${r.tokens ?? '?'} completion tokens, ${r.tps === null ? '? tokens/s' : `${r.tps.toFixed(1)} tokens/s`} (budget ${budget} ms)`);
  return { violations, report, timed: rows.length, untimedLegacy: false };
}
