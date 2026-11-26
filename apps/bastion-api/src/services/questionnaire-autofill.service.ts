// Questionnaire autofill (spec 2.7, 7, 7.3), driven by the worker exactly like M7's compile:
// POST /questionnaires/:id/autofill sets the questionnaire `answering` (unclaimed = queued) and
// enqueues bastion-questionnaire-autofill; that job calls POST /internal/engines/questionnaire-
// autofill, which claims the questionnaire (fenced on the worker's claimant), starts a slice in
// the background and answers at once; the worker polls every 10 s.
//
// A slice stops starting LLM calls at 150 s INCLUDING the wait for a leased permit (3 service-
// wide, 1 per org), heartbeats after every call and every 20 s while it waits, and writes each
// question in its own transaction (draft, band, counts and heartbeat together, fenced on the
// claim), so a crash or a deploy leaves only whole rows behind and the next slice skips them. On
// SIGTERM it stops starting calls, lets the current one finish and releases the questionnaire
// (resume_count + 1); after three releases the rows still undrafted are marked "Needs an expert"
// and the questionnaire goes to review, never back to mapping.
//
// Per question: pre-scan, lexical retrieval over the org's own records, one LLM call over
// delimited data, then the deterministic verifier and bander (library/questionnaire-draft.ts),
// with can_access on every citation for the person who started the autofill.

import { BASTION_CONFIDENCE_WORDS, type BastionDraftAnswer, type BastionQuestionnaireSlice } from '@bigbluebam/shared';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { LLM_SLICE_START_CUTOFF_MS, MAX_RESUMES, STALE_HEARTBEAT_MS } from '../engine/budgets.js';
import { RunLeaseHeldError, RunNotFoundError } from '../engine/evaluator.js';
import { loadControlStates } from '../engine/numbers.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import { scanLabel } from '../lib/injection-prescan.js';
import { LlmError, LlmThrottledError, type LlmChat } from '../lib/llm-errors.js';
import type { LlmPermits } from '../lib/llm-permits.js';
import { BASTION_LLM_CALLS } from '../library/llm-call-settings.js';
import {
  AI_REASONS,
  type BandReason,
  type BandResult,
  bandAnswer,
  buildDraftMessages,
  type DraftCandidate,
  type DraftResponse,
  MAX_CANDIDATES,
  notDrafted,
  parseDraftResponse,
  tsQueryTerms,
  withAiReason,
} from '../library/questionnaire-draft.js';
import type { SliceLock } from './compile-ai.service.js';
import { COMPILE_SLICE_LOCK_MS, resolveLlmProviderId, takeSliceLock } from './compile-ai.service.js';

export const AUTOFILL_HEARTBEAT_EVERY_MS = 20_000;
export const AUTOFILL_PERMIT_RETRY_MS = 2_000;
/** Outlives the longest slice: the start cutoff plus one call at the longest allowed deadline (#257). */
export const AUTOFILL_SLICE_LOCK_MS = COMPILE_SLICE_LOCK_MS;
export const DEFAULT_MAX_LLM_CALLS_PER_QUESTIONNAIRE = 1200;
const DEFAULT_FLOORS = { high: 0.8, medium: 0.55 };

export type CanAccess = (asker: string, entityType: string, entityId: string) => Promise<boolean>;

export interface AutofillDeps {
  engine: EngineDeps;
  llm: LlmChat;
  permits: LlmPermits;
  sliceLock: SliceLock;
  canAccess: CanAccess;
  /** Production starts the slice and answers at once; the tests await it. */
  background: boolean;
  sleep?: (ms: number) => Promise<void>;
  shuttingDown?: () => boolean;
  sliceCutoffMs?: number;
  /** max_tokens per answer (env BASTION_QUESTIONNAIRE_MAX_TOKENS; llm-call-settings.ts questionnaire_draft). */
  maxTokens?: number;
}

/* ------------------------------ retrieval ------------------------------ */

export interface OrgDraftContext {
  /** Effective state per control id (null = not set up); controls missing from the map count as not set up. */
  states: Map<string, DraftCandidate['state']>;
  exceptions: Map<string, { reason: string; expires_at: string }>;
  floors: { high: number; medium: number };
  maxCalls: number;
  providerId: string | null;
}

/** What every question in one slice shares: control states, exception reasons, floors, provider. */
export async function loadDraftContext(tx: Tx, orgId: string, now: Date): Promise<OrgDraftContext> {
  const loaded = await loadControlStates(tx, orgId, now);
  const states = new Map<string, DraftCandidate['state']>();
  for (const c of loaded.controls) states.set(c.control_id, c.verdict.state);
  const ex = await tx`
    SELECT DISTINCT ON (control_id) control_id, reason, expires_at FROM bastion_exceptions
     WHERE organization_id = ${orgId} AND status = 'active' ORDER BY control_id, expires_at DESC`;
  const exceptions = new Map<string, { reason: string; expires_at: string }>();
  for (const e of ex) exceptions.set(String(e.control_id), { reason: String(e.reason), expires_at: new Date(e.expires_at as string).toISOString() });
  const s = (await tx`
    SELECT questionnaire_high_floor, questionnaire_medium_floor, max_llm_calls_per_questionnaire
      FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  return {
    states,
    exceptions,
    floors: { high: Number(s?.questionnaire_high_floor ?? DEFAULT_FLOORS.high), medium: Number(s?.questionnaire_medium_floor ?? DEFAULT_FLOORS.medium) },
    maxCalls: Number(s?.max_llm_calls_per_questionnaire ?? DEFAULT_MAX_LLM_CALLS_PER_QUESTIONNAIRE),
    providerId: await resolveLlmProviderId(tx, orgId),
  };
}

/**
 * Lexical retrieval (spec 2.7 step 4): Postgres full-text search over the org's approved answers
 * (current, not stale), controls with their confirmed check statements, and linked policy titles.
 * Returns at most MAX_CANDIDATES, best first, with handles C1.., P1.., L1...
 */
export async function retrieveCandidates(tx: Tx, orgId: string, question: string, ctx: Pick<OrgDraftContext, 'states' | 'exceptions'>): Promise<DraftCandidate[]> {
  const terms = tsQueryTerms(question);
  if (!terms) return [];
  const controls = await tx`
    SELECT c.id, c.title, coalesce(c.plain_summary, '') AS summary, ts_rank_cd(c.tsv, q) AS rank
      FROM bastion_controls c, to_tsquery('english', ${terms}) q
     WHERE c.organization_id = ${orgId} AND c.lifecycle = 'active' AND c.tsv @@ q
     ORDER BY rank DESC LIMIT 6`;
  const statements = await tx`
    SELECT a.control_id, c.title, coalesce(c.plain_summary, '') AS summary, a.plain_statement,
           ts_rank_cd(to_tsvector('english', a.plain_statement), q) AS rank
      FROM bastion_assertions a
      JOIN bastion_controls c ON c.id = a.control_id AND c.organization_id = a.organization_id,
           to_tsquery('english', ${terms}) q
     WHERE a.organization_id = ${orgId} AND a.review_status = 'confirmed' AND c.lifecycle = 'active'
       AND to_tsvector('english', a.plain_statement) @@ q
     ORDER BY rank DESC LIMIT 8`;
  const policies = await tx`
    SELECT p.id, be.title, ts_rank_cd(to_tsvector('english', be.title), q) AS rank
      FROM bastion_policies p
      JOIN beacon_entries be ON be.id = p.beacon_entry_id AND be.organization_id = p.organization_id,
           to_tsquery('english', ${terms}) q
     WHERE p.organization_id = ${orgId} AND p.status = 'active' AND to_tsvector('english', be.title) @@ q
     ORDER BY rank DESC LIMIT 3`;
  const library = await tx`
    SELECT id, question_text, answer_text, yes_no, cited_refs, ts_rank_cd(tsv, q) AS rank
      FROM bastion_answer_library, to_tsquery('english', ${terms}) q
     WHERE organization_id = ${orgId} AND retired_at IS NULL AND NOT stale AND tsv @@ q
     ORDER BY rank DESC LIMIT 3`;

  const byControl = new Map<string, { title: string; summary: string; statements: string[]; rank: number }>();
  for (const c of controls) byControl.set(String(c.id), { title: String(c.title), summary: String(c.summary), statements: [], rank: Number(c.rank) });
  for (const s of statements) {
    const id = String(s.control_id);
    const cur = byControl.get(id) ?? { title: String(s.title), summary: String(s.summary), statements: [], rank: 0 };
    if (cur.statements.length < 3) cur.statements.push(String(s.plain_statement));
    cur.rank = Math.max(cur.rank, Number(s.rank)) + 0.01;
    byControl.set(id, cur);
  }
  const pool: Array<Omit<DraftCandidate, 'handle'>> = [];
  for (const [id, c] of byControl) {
    pool.push({
      kind: 'control',
      refs: [{ entity_type: 'bastion.control', entity_id: id }],
      title: c.title,
      text: [c.summary, ...c.statements].filter(Boolean).join(' '),
      rank: c.rank,
      state: ctx.states.has(id) ? (ctx.states.get(id) ?? null) : null,
      exception: ctx.states.get(id) === 'pass_with_exception' ? (ctx.exceptions.get(id) ?? null) : null,
    });
  }
  for (const p of policies) {
    pool.push({ kind: 'policy', refs: [{ entity_type: 'bastion.policy', entity_id: String(p.id) }], title: String(p.title), text: 'A written policy the organization asks its people to read.', rank: Number(p.rank) });
  }
  for (const l of library) {
    const refs = ((l.cited_refs as Array<{ entity_type?: unknown; entity_id?: unknown }> | null) ?? [])
      .filter((r) => typeof r?.entity_type === 'string' && typeof r?.entity_id === 'string')
      .map((r) => ({ entity_type: String(r.entity_type), entity_id: String(r.entity_id) }));
    pool.push({
      kind: 'library',
      refs,
      title: String(l.question_text).slice(0, 300),
      text: '',
      rank: Number(l.rank) + 0.05,
      library: { answer: String(l.answer_text), yes_no: (l.yes_no as boolean | null) ?? null },
    });
  }
  pool.sort((a, b) => b.rank - a.rank);
  const counters = { control: 0, policy: 0, library: 0 };
  const prefix = { control: 'C', policy: 'P', library: 'L' } as const;
  // A library answer's citations are controls too: their states come from the same map.
  return pool.slice(0, MAX_CANDIDATES).map((c) => {
    counters[c.kind] += 1;
    return { ...c, handle: `${prefix[c.kind]}${counters[c.kind]}` };
  });
}

/** Controls a reused library answer cites, as candidates (so the hard rules see their states). */
function libraryControlCandidates(cands: DraftCandidate[], ctx: Pick<OrgDraftContext, 'states' | 'exceptions'>): DraftCandidate[] {
  const have = new Set(cands.filter((c) => c.kind === 'control').map((c) => c.refs[0]?.entity_id));
  const extra: DraftCandidate[] = [];
  for (const c of cands.filter((x) => x.kind === 'library')) {
    for (const r of c.refs) {
      if (r.entity_type !== 'bastion.control' || have.has(r.entity_id)) continue;
      have.add(r.entity_id);
      const state = ctx.states.has(r.entity_id) ? (ctx.states.get(r.entity_id) ?? null) : null;
      extra.push({
        handle: `X${extra.length + 1}`,
        kind: 'control',
        refs: [r],
        title: 'a control this answer relies on',
        text: '',
        rank: 0,
        state,
        exception: state === 'pass_with_exception' ? (ctx.exceptions.get(r.entity_id) ?? null) : null,
      });
    }
  }
  return extra;
}

/** can_access for every entity a candidate could cite, for this asker (fail closed, cached per slice). */
export async function visibleRefs(canAccess: CanAccess, asker: string, cands: DraftCandidate[], cache: Map<string, boolean>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of cands) {
    for (const r of c.refs) {
      const k = `${r.entity_type}:${r.entity_id}`;
      let ok = cache.get(k);
      if (ok === undefined) {
        ok = await canAccess(asker, r.entity_type, r.entity_id).catch(() => false);
        cache.set(k, ok);
      }
      if (ok) out.add(k);
    }
  }
  return out;
}

/** Band one question given the model's answer (or null), with the hard rules applied. */
export function bandWithContext(question: string, answerKind: BastionDraftAnswer['answer_kind'], cands: DraftCandidate[], response: DraftResponse | null, visible: Set<string>, ctx: OrgDraftContext): BandResult {
  const all = [...cands, ...libraryControlCandidates(cands, ctx)];
  return bandAnswer({ question, answer_kind: answerKind, candidates: all, response, visible, floors: ctx.floors });
}

/* ------------------------------ one LLM call ------------------------------ */

/**
 * What one attempt to get an AI answer came to (#260, #261):
 *   answer            the model answered and the answer parsed; the bander judges it
 *   unusable          the model answered but it was cut off (finish_reason length) or unreadable;
 *                     the row is banded with that reason recorded (retrying would pay again for
 *                     the same result)
 *   ai_failed         the call itself failed (proxy unreachable, 5xx, timeout): transient, so the
 *                     row stays undrafted and is retried after a back-off
 *   budget_exhausted  the questionnaire's AI-call allowance is spent; no call was made
 *   out_of_time       the slice's time budget ran out (or SIGTERM) before a call started
 */
type AiOutcome =
  | { kind: 'answer'; response: DraftResponse }
  | { kind: 'unusable'; cutOff: boolean; reason: string }
  | { kind: 'ai_failed'; reason: string }
  | { kind: 'budget_exhausted' }
  | { kind: 'out_of_time' };

interface CallHooks {
  heartbeat: () => Promise<void>;
  onWaiting: (w: 'ai_slot' | 'ai_throttled' | null) => void;
  log: EngineDeps['log'];
  /** Charge one AI call to the questionnaire BEFORE it is made (#261); false = the allowance is spent. */
  charge?: () => Promise<boolean>;
}

/** Consecutive transient AI failures on one questionnaire before the undrafted rest goes to review (#260). */
export const AUTOFILL_MAX_AI_FAILURES = 6;

/** Back-off after the n-th consecutive transient failure: 5 s, 10 s, 20 s, 40 s, then 60 s. */
export function aiRetryDelayMs(streak: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, streak - 1));
}

async function askAi(
  d: Pick<AutofillDeps, 'llm' | 'permits' | 'sleep' | 'shuttingDown' | 'maxTokens'>,
  orgId: string,
  providerId: string,
  messages: ReturnType<typeof buildDraftMessages>,
  sliceStart: number,
  cutoff: number,
  hooks: CallHooks,
): Promise<AiOutcome> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastBeat = Date.now();
  let first = true;
  let announced = false;
  for (;;) {
    if (!first && Date.now() - sliceStart > cutoff) return { kind: 'out_of_time' };
    first = false;
    if (stopping || d.shuttingDown?.()) return { kind: 'out_of_time' };
    const admission = await d.permits.tryAdmit(orgId);
    if (!admission.admitted) {
      if (!announced) hooks.log.info({ organization_id: orgId }, 'bastion-autofill: waiting for an AI slot (org limit 1)');
      announced = true;
      hooks.onWaiting('ai_slot');
      if (Date.now() - lastBeat >= AUTOFILL_HEARTBEAT_EVERY_MS) {
        await hooks.heartbeat();
        lastBeat = Date.now();
      }
      await sleep(AUTOFILL_PERMIT_RETRY_MS);
      continue;
    }
    hooks.onWaiting(null);
    let released = false;
    try {
      // Every call is charged before it is made, a throttled retry included, so a crash after
      // the call still counts it (#261).
      if (hooks.charge && !(await hooks.charge())) return { kind: 'budget_exhausted' };
      // The questionnaire_draft budget (library/llm-call-settings.ts; env
      // BASTION_QUESTIONNAIRE_MAX_TOKENS), the same value the corpus was recorded and is gated at.
      const res = await d.llm({ providerId, messages, maxTokens: d.maxTokens ?? BASTION_LLM_CALLS.questionnaire_draft.maxTokensDefault });
      const parsed = parseDraftResponse(res.content, res.finish_reason);
      return parsed.ok ? { kind: 'answer', response: parsed.value } : { kind: 'unusable', cutOff: parsed.cutOff, reason: parsed.reason };
    } catch (err) {
      if (err instanceof LlmThrottledError) {
        hooks.onWaiting('ai_throttled');
        const wait = Math.min(err.retryAfterSeconds, 30) * 1000;
        hooks.log.info({ organization_id: orgId }, `bastion-autofill: throttled by the AI provider, resuming in ${Math.round(wait / 1000)} s`);
        released = true;
        await admission.release();
        await sleep(wait);
        continue;
      }
      if (err instanceof ClaimLostError) throw err;
      return { kind: 'ai_failed', reason: err instanceof LlmError ? `the AI call failed (${err.message})` : 'the AI call failed' };
    } finally {
      if (!released) await admission.release();
    }
  }
}

/**
 * POST /answers/draft (row 81): draft one answer now, nothing saved. Waits for an AI slot for at
 * most `waitMs`; without a provider (or a slot) the answer comes from the library or is empty and
 * low. Citations pass can_access for the caller.
 */
export async function draftOneAnswer(
  d: Pick<AutofillDeps, 'engine' | 'llm' | 'permits' | 'canAccess' | 'sleep' | 'maxTokens'>,
  viewer: { id: string; org_id: string },
  body: BastionDraftAnswer,
  waitMs = 20_000,
  /** An agent drafting for a person (#274): citations must pass can_access for them too. Narrows, never widens. */
  asker: string | null = null,
) {
  const now = d.engine.now();
  const { ctx, cands } = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const c = await loadDraftContext(tx, viewer.org_id, now);
    return { ctx: c, cands: await retrieveCandidates(tx, viewer.org_id, body.question, c) };
  });
  let response: DraftResponse | null = null;
  let note: string | null = null;
  let aiReason: BandReason | null = null;
  if (ctx.providerId) {
    const out = await askAi(d, viewer.org_id, ctx.providerId, buildDraftMessages({ question: body.question, section: null, answer_kind: body.answer_kind, candidates: cands }), Date.now(), waitMs, {
      heartbeat: async () => undefined,
      onWaiting: () => undefined,
      log: d.engine.log,
    });
    if (out.kind === 'answer') response = out.response;
    else if (out.kind === 'unusable') {
      note = out.reason;
      aiReason = out.cutOff ? AI_REASONS.ai_cut_off : AI_REASONS.ai_bad_answer;
    } else if (out.kind === 'ai_failed') {
      note = out.reason;
      aiReason = AI_REASONS.ai_unavailable;
      d.engine.log.warn({ organization_id: viewer.org_id, reason: out.reason }, 'bastion-draft: the AI call failed; the answer comes from the library or is empty');
    } else note = 'every AI slot was busy';
  } else note = 'no AI provider is set up';
  const all = [...cands, ...libraryControlCandidates(cands, ctx)];
  const visible = await visibleRefs(d.canAccess, viewer.id, all, new Map());
  if (asker && asker !== viewer.id) {
    const forAsker = await visibleRefs(d.canAccess, asker, all, new Map());
    for (const k of [...visible]) if (!forAsker.has(k)) visible.delete(k);
  }
  let banded = bandWithContext(body.question, body.answer_kind, cands, response, visible, ctx);
  if (aiReason) banded = withAiReason(banded, aiReason);
  const labels = new Map<string, string>();
  for (const c of cands) for (const r of c.refs) if (c.kind !== 'library') labels.set(`${r.entity_type}:${r.entity_id}`, c.title);
  return {
    data: {
      ...banded,
      confidence_words: BASTION_CONFIDENCE_WORDS[banded.confidence_band],
      citations: banded.cited_refs.map((r) => ({ ...r, label: labels.get(`${r.entity_type}:${r.entity_id}`) ?? null })),
      drafted_by_ai: response !== null,
      note,
    },
  };
}

/* ------------------------------ the engine ------------------------------ */

interface QRow {
  id: string;
  organization_id: string;
  title: string;
  status: string;
  claimed_by: string | null;
  heartbeat_at: string | Date | null;
  row_count: number;
  rows_done: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  resume_count: number;
  owner_user_id: string | null;
  created_by: string | null;
  asker: string | null;
  slice_token: string | null;
  /** Up by one on every start (#267): the drafted event's idempotency key is per run. */
  autofill_generation: number;
  /** false: this run never calls the AI (the deterministic path, #271). */
  autofill_use_ai: boolean;
  /** AI calls charged to this questionnaire across every run (#261); never reset by a redraft. */
  llm_calls_used: number;
  /** Consecutive transient AI failures (#260). */
  ai_failure_streak: number;
}

/** One slice's ownership of the questionnaire row: the worker's claimant AND this slice's token (#242). */
interface QFence {
  claimant: string;
  token: string;
}

const active = new Map<string, Promise<void>>();
const waitingState = new Map<string, 'ai_slot' | 'ai_throttled' | null>();
let stopping = false;

/** SIGTERM: stop starting LLM calls (spec 7.3). */
export function markAutofillShuttingDown(): void {
  stopping = true;
}

/** Wait for in-flight slices (each finishes its current call, then releases its questionnaire). */
export async function drainAutofillSlices(timeoutMs: number): Promise<number> {
  const pending = [...active.values()];
  if (pending.length === 0) return 0;
  await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
  return pending.length;
}

const SELECT_Q = (tx: Tx, orgId: string, id: string) => tx`
  SELECT id, organization_id, title, status, claimed_by, heartbeat_at, slice_token, row_count, rows_done, high_count, medium_count, low_count,
         resume_count, owner_user_id, created_by, column_map->>'autofill_requested_by' AS asker,
         llm_calls_used, ai_failure_streak, autofill_generation, autofill_use_ai
    FROM bastion_questionnaires WHERE organization_id = ${orgId} AND id = ${id}`;

async function readQ(d: AutofillDeps, orgId: string, id: string): Promise<QRow | null> {
  const r = await orgTx(d.engine.sql, orgId, (tx) => SELECT_Q(tx, orgId, id));
  return (r[0] as unknown as QRow | undefined) ?? null;
}

function sliceView(q: QRow, running: boolean, extra: Partial<BastionQuestionnaireSlice> = {}): BastionQuestionnaireSlice {
  return {
    done: q.status !== 'answering',
    status: q.status as BastionQuestionnaireSlice['status'],
    rows_done: Number(q.rows_done),
    row_count: Number(q.row_count),
    high: Number(q.high_count),
    medium: Number(q.medium_count),
    low: Number(q.low_count),
    slice_running: running,
    waiting: waitingState.get(q.id) ?? null,
    llm_calls_used: Number(q.llm_calls_used ?? 0),
    ai_failure_streak: Number(q.ai_failure_streak ?? 0),
    ...extra,
  };
}

/**
 * POST /internal/engines/questionnaire-autofill: claim for `claimant` and start (or report on) a
 * slice. 404 RunNotFoundError; 409 RunLeaseHeldError when another live claimant holds it.
 */
export async function autofillSlice(d: AutofillDeps, body: { organization_id: string; questionnaire_id: string; claimant: string }): Promise<BastionQuestionnaireSlice> {
  const { organization_id: orgId, questionnaire_id: id, claimant } = body;
  const q = await readQ(d, orgId, id);
  if (!q) throw new RunNotFoundError();
  if (q.status !== 'answering') return sliceView(q, false);
  if (active.has(id)) return sliceView(q, true);

  // Same two layers as the compile (#242): the Redis pre-check (an error means "Postgres fences
  // alone", never "acquired"), then the slice_token claim that every slice write is fenced on.
  const lockKey = `q:${id}`;
  const lockToken = await takeSliceLock(d.sliceLock, lockKey, AUTOFILL_SLICE_LOCK_MS, d.engine.log);
  if (lockToken === null) return sliceView(q, true);
  const releaseLock = async () => {
    if (lockToken !== 'unavailable') await d.sliceLock.release(lockKey, lockToken).catch(() => undefined);
  };

  const now = d.engine.now();
  const takeoverBefore = new Date(now.getTime() - d.engine.leaseMs);
  let claimed: readonly Record<string, unknown>[];
  try {
    claimed = await orgTx(d.engine.sql, orgId, (tx) => tx`
      UPDATE bastion_questionnaires SET claimed_by = ${claimant}, heartbeat_at = ${now}, slice_token = gen_random_uuid()
       WHERE organization_id = ${orgId} AND id = ${id} AND status = 'answering'
         AND (claimed_by IS NULL OR claimed_by = ${claimant} OR heartbeat_at IS NULL OR heartbeat_at < ${takeoverBefore})
         AND (slice_token IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ${takeoverBefore})
      RETURNING id, slice_token`);
  } catch (err) {
    await releaseLock();
    throw err;
  }
  if (!claimed[0]) {
    await releaseLock();
    const cur = await readQ(d, orgId, id);
    if (!cur) throw new RunNotFoundError();
    if (cur.status !== 'answering') return sliceView(cur, false);
    if (cur.claimed_by === claimant && cur.slice_token) return sliceView(cur, true);
    const stale = !cur.heartbeat_at || now.getTime() - new Date(cur.heartbeat_at).getTime() > STALE_HEARTBEAT_MS;
    throw new RunLeaseHeldError(cur.claimed_by, stale);
  }
  const fence: QFence = { claimant, token: String(claimed[0].slice_token) };
  const mine = (await readQ(d, orgId, id)) as QRow;

  const slice = runSlice(d, mine, fence)
    .catch(async (err) => {
      if (err instanceof ClaimLostError) {
        d.engine.log.info({ questionnaire_id: id }, 'bastion-autofill: slice stopped; another slice owns the questionnaire now');
        return;
      }
      // Same bound as the compile (#241): a slice that throws gives the questionnaire back with
      // resume_count + 1, and at MAX_RESUMES the undrafted rows go to review as "Needs an expert",
      // instead of the next poll re-driving (and re-paying for) the same failing row forever.
      await releaseQ(d, mine, fence).catch(() => undefined);
      d.engine.log.error({ questionnaire_id: id, err: (err as Error).message }, 'bastion-autofill: slice failed; the questionnaire was released (sent to review after repeated failures)');
    })
    .finally(async () => {
      active.delete(id);
      waitingState.delete(id);
      await orgTx(d.engine.sql, orgId, (tx) => tx`
        UPDATE bastion_questionnaires SET slice_token = NULL
         WHERE organization_id = ${orgId} AND id = ${id} AND slice_token = ${fence.token}`).catch(() => undefined);
      await releaseLock();
    });
  active.set(id, slice);
  if (!d.background) {
    await slice;
    const after = await readQ(d, orgId, id);
    return sliceView(after ?? mine, false);
  }
  return sliceView(mine, true);
}

class ClaimLostError extends Error {
  constructor() {
    super('the questionnaire was taken over by another claimant');
    this.name = 'ClaimLostError';
  }
}

async function heartbeat(d: AutofillDeps, q: QRow, f: QFence): Promise<void> {
  const r = await orgTx(d.engine.sql, q.organization_id, (tx) => tx`
    UPDATE bastion_questionnaires SET heartbeat_at = ${d.engine.now()}
     WHERE id = ${q.id} AND organization_id = ${q.organization_id} AND claimed_by = ${f.claimant} AND slice_token = ${f.token} AND status = 'answering'
    RETURNING id`);
  if (!r[0]) throw new ClaimLostError();
}

const NOT_DRAFTED_REASONS = JSON.stringify(notDrafted().band_reasons);

/** Recount the bands from the items (the single source), inside the caller's transaction. */
async function recount(tx: Tx, orgId: string, id: string) {
  return (await tx`
    SELECT count(*) FILTER (WHERE confidence_band IS NOT NULL)::int AS done,
           count(*) FILTER (WHERE confidence_band = 'high')::int AS high,
           count(*) FILTER (WHERE confidence_band = 'medium')::int AS medium,
           count(*) FILTER (WHERE confidence_band = 'low')::int AS low,
           count(*)::int AS total
      FROM bastion_questionnaire_items WHERE organization_id = ${orgId} AND questionnaire_id = ${id}`)[0] as { done: number; high: number; medium: number; low: number; total: number };
}

/** Give the questionnaire back (SIGTERM): queued again, or after MAX_RESUMES the rest marked and sent to review. */
async function releaseQ(d: AutofillDeps, q: QRow, f: QFence): Promise<void> {
  await orgTx(d.engine.sql, q.organization_id, async (tx) => {
    const r = await tx`
      UPDATE bastion_questionnaires SET claimed_by = NULL, heartbeat_at = NULL, slice_token = NULL, resume_count = resume_count + 1
       WHERE id = ${q.id} AND organization_id = ${q.organization_id} AND claimed_by = ${f.claimant} AND slice_token = ${f.token} AND status = 'answering'
      RETURNING resume_count`;
    if (r[0] && Number(r[0].resume_count) >= MAX_RESUMES) await parkQuestionnaire(tx, q.organization_id, q.id);
  });
}

/**
 * After three releases (or AUTOFILL_MAX_AI_FAILURES failed AI calls in a row, #260): every
 * undrafted row becomes "Needs an expert" with the reason, and the questionnaire goes to review.
 */
export async function parkQuestionnaire(tx: Tx, orgId: string, id: string, reasons: string = NOT_DRAFTED_REASONS): Promise<void> {
  await tx`
    UPDATE bastion_questionnaire_items
       SET confidence_band = 'low', confidence = 0, band_reasons = ${reasons}::text::jsonb
     WHERE organization_id = ${orgId} AND questionnaire_id = ${id} AND confidence_band IS NULL`;
  const n = await recount(tx, orgId, id);
  await tx`
    UPDATE bastion_questionnaires
       SET status = 'in_review', claimed_by = NULL, heartbeat_at = NULL, slice_token = NULL, rows_done = ${n.done}, row_count = ${n.total},
           high_count = ${n.high}, medium_count = ${n.medium}, low_count = ${n.low}
     WHERE organization_id = ${orgId} AND id = ${id} AND status = 'answering'`;
}

/**
 * Charge one AI call to the questionnaire, in its own statement BEFORE the call (#261): a crash or
 * a failed write after the call still counts it, a throttled retry counts, and a redraft never
 * resets it. False when the allowance (max_llm_calls_per_questionnaire) is spent. Fenced on the
 * slice (#242) like every other slice write.
 */
async function chargeCall(d: AutofillDeps, q: QRow, f: QFence, maxCalls: number): Promise<boolean> {
  const r = await orgTx(d.engine.sql, q.organization_id, (tx) => tx`
    UPDATE bastion_questionnaires SET llm_calls_used = llm_calls_used + 1
     WHERE id = ${q.id} AND organization_id = ${q.organization_id} AND claimed_by = ${f.claimant} AND slice_token = ${f.token}
       AND status = 'answering' AND llm_calls_used < ${maxCalls}
    RETURNING llm_calls_used`);
  if (r[0]) return true;
  const cur = await readQ(d, q.organization_id, q.id);
  if (!cur || cur.status !== 'answering' || cur.claimed_by !== f.claimant || cur.slice_token !== f.token) throw new ClaimLostError();
  return false;
}

/** Record one transient AI failure (#260); returns the consecutive count. */
async function recordAiFailure(d: AutofillDeps, q: QRow, f: QFence, reason: string): Promise<number> {
  const r = await orgTx(d.engine.sql, q.organization_id, (tx) => tx`
    UPDATE bastion_questionnaires
       SET ai_failure_streak = ai_failure_streak + 1, last_ai_failure = ${reason.slice(0, 500)}, heartbeat_at = ${d.engine.now()}
     WHERE id = ${q.id} AND organization_id = ${q.organization_id} AND claimed_by = ${f.claimant} AND slice_token = ${f.token} AND status = 'answering'
    RETURNING ai_failure_streak`);
  if (!r[0]) throw new ClaimLostError();
  return Number(r[0].ai_failure_streak);
}

/** Sleep `ms`, heartbeating the claim at least every AUTOFILL_HEARTBEAT_EVERY_MS. */
async function waitWithHeartbeat(d: AutofillDeps, q: QRow, f: QFence, ms: number): Promise<void> {
  const sleep = d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
  let left = ms;
  while (left > 0) {
    const step = Math.min(left, AUTOFILL_HEARTBEAT_EVERY_MS);
    await sleep(step);
    left -= step;
    await heartbeat(d, q, f);
  }
}

async function runSlice(d: AutofillDeps, q: QRow, f: QFence): Promise<void> {
  const sliceStart = Date.now();
  const cutoff = d.sliceCutoffMs ?? LLM_SLICE_START_CUTOFF_MS;
  const orgId = q.organization_id;
  const asker = q.asker ?? q.owner_user_id ?? q.created_by;
  const ctx = await orgTx(d.engine.sql, orgId, (tx) => loadDraftContext(tx, orgId, d.engine.now()));
  const items = await orgTx(d.engine.sql, orgId, (tx) => tx`
    SELECT id, row_index, sheet_name, section, question_text, answer_kind FROM bastion_questionnaire_items
     WHERE organization_id = ${orgId} AND questionnaire_id = ${q.id} AND confidence_band IS NULL
     ORDER BY sheet_name, row_index`);
  const total = Number(q.row_count);
  let done = Number(q.rows_done);
  d.engine.log.info(
    { questionnaire_id: q.id, resume_count: q.resume_count },
    `bastion-autofill: questionnaire '${q.title}' slice starting; rows ${done}/${total} (an AI answer takes 10-20 s; a 96-row questionnaire about 16-32 minutes)`,
  );
  const accessCache = new Map<string, boolean>();
  let processed = 0;
  // Per-slice tallies for the progress line (#260): failed calls (rows left undrafted and retried)
  // and answers that came back unusable (cut off or unreadable, banded with that reason).
  let aiFailed = 0;
  let unusable = 0;
  let i = 0;
  while (i < items.length) {
    const it = items[i] as (typeof items)[number];
    if (stopping || d.shuttingDown?.()) {
      await releaseQ(d, q, f);
      d.engine.log.info({ questionnaire_id: q.id }, 'bastion-autofill: shutting down; the questionnaire was released and will resume');
      return;
    }
    if (processed > 0 && Date.now() - sliceStart > cutoff) break;
    processed += 1;
    const question = String(it.question_text);
    const answerKind = String(it.answer_kind) as BastionDraftAnswer['answer_kind'];
    const suspect = scanLabel(question).suspected;
    const cands = await orgTx(d.engine.sql, orgId, (tx) => retrieveCandidates(tx, orgId, question, ctx));

    let response: DraftResponse | null = null;
    let aiReason: BandReason | null = null;
    let aiReached = false;
    // use_ai false (#271): no AI call; the bander still reuses library answers and applies the hard rules.
    if (q.autofill_use_ai !== false && ctx.providerId && cands.length > 0) {
      const messages = buildDraftMessages({ question, section: (it.section as string | null) ?? null, answer_kind: answerKind, candidates: cands });
      const out = await askAi(d, orgId, ctx.providerId, messages, sliceStart, cutoff, {
        heartbeat: () => heartbeat(d, q, f),
        onWaiting: (w) => waitingState.set(q.id, w),
        log: d.engine.log,
        charge: () => chargeCall(d, q, f, ctx.maxCalls),
      });
      if (out.kind === 'out_of_time') {
        if (stopping || d.shuttingDown?.()) {
          await releaseQ(d, q, f);
          return;
        }
        break;
      }
      if (out.kind === 'ai_failed') {
        // Transient (#260): the row stays undrafted. Back off and try the same row again; after
        // AUTOFILL_MAX_AI_FAILURES in a row the rest goes to review saying the AI was unavailable.
        aiFailed += 1;
        const streak = await recordAiFailure(d, q, f, out.reason);
        d.engine.log.warn(
          { questionnaire_id: q.id, item_id: it.id, reason: out.reason, streak },
          `bastion-autofill: the AI call failed (${streak} in a row); the row stays undrafted and is tried again`,
        );
        if (streak >= AUTOFILL_MAX_AI_FAILURES) {
          await orgTx(d.engine.sql, orgId, (tx) => parkQuestionnaire(tx, orgId, q.id, JSON.stringify([AI_REASONS.ai_unavailable])));
          d.engine.log.warn(
            { questionnaire_id: q.id, reason: out.reason },
            `bastion-autofill: questionnaire '${q.title}': the AI failed ${streak} times in a row; the undrafted rows go to review as "Needs an expert" (the AI was unavailable). Ask for new drafts when it is back.`,
          );
          return;
        }
        const wait = aiRetryDelayMs(streak);
        if (Date.now() - sliceStart + wait > cutoff) break; // the next slice tries again
        await waitWithHeartbeat(d, q, f, wait);
        continue; // the same row
      }
      if (out.kind === 'budget_exhausted') {
        aiReason = AI_REASONS.budget_exhausted;
      } else if (out.kind === 'unusable') {
        aiReached = true;
        unusable += 1;
        aiReason = out.cutOff ? AI_REASONS.ai_cut_off : AI_REASONS.ai_bad_answer;
        d.engine.log.warn(
          { questionnaire_id: q.id, item_id: it.id, reason: out.reason },
          out.cutOff
            ? 'bastion-autofill: the AI answer stopped at max_tokens (finish_reason length); raise BASTION_QUESTIONNAIRE_MAX_TOKENS if this repeats'
            : `bastion-autofill: the AI answer could not be used (${out.reason})`,
        );
      } else {
        aiReached = true;
        response = out.response;
      }
    }
    const visible = asker ? await visibleRefs(d.canAccess, asker, [...cands, ...libraryControlCandidates(cands, ctx)], accessCache) : new Set<string>();
    let b = bandWithContext(question, answerKind, cands, response, visible, ctx);
    if (aiReason) b = withAiReason(b, aiReason);

    const counts = await orgTx(d.engine.sql, orgId, async (tx) => {
      await tx`
        UPDATE bastion_questionnaire_items
           SET draft_answer = ${b.draft_answer}, draft_yes_no = ${b.draft_yes_no}, cited_refs = ${tx.json(b.cited_refs as never)},
               dropped_citation_count = ${b.dropped_citation_count}, confidence = ${b.confidence}, confidence_band = ${b.confidence_band},
               band_reasons = ${tx.json(b.band_reasons as never)}
         WHERE organization_id = ${orgId} AND id = ${it.id as string} AND confidence_band IS NULL`;
      const n = await recount(tx, orgId, q.id);
      const upd = await tx`
        UPDATE bastion_questionnaires
           SET rows_done = ${n.done}, high_count = ${n.high}, medium_count = ${n.medium}, low_count = ${n.low},
               injection_suspected = injection_suspected OR ${suspect}, heartbeat_at = ${d.engine.now()},
               ai_failure_streak = CASE WHEN ${aiReached} THEN 0 ELSE ai_failure_streak END
         WHERE id = ${q.id} AND organization_id = ${orgId} AND claimed_by = ${f.claimant} AND slice_token = ${f.token} AND status = 'answering'
        RETURNING id`;
      if (!upd[0]) throw new ClaimLostError();
      return n;
    });
    done = counts.done;
    i += 1;
    d.engine.log.info(
      { questionnaire_id: q.id },
      `bastion-autofill: questionnaire '${q.title}' rows ${counts.done}/${counts.total} (high ${counts.high}, medium ${counts.medium}, low ${counts.low}; ` +
        `this slice: ${aiFailed} failed AI calls, ${unusable} unusable AI answers) elapsed_ms=${Date.now() - sliceStart}`,
    );
  }

  const left = await orgTx(d.engine.sql, orgId, (tx) => tx`
    SELECT count(*)::int AS n FROM bastion_questionnaire_items WHERE organization_id = ${orgId} AND questionnaire_id = ${q.id} AND confidence_band IS NULL`);
  if (Number(left[0]?.n ?? 0) > 0) {
    d.engine.log.info({ questionnaire_id: q.id }, `bastion-autofill: slice ended at ${done}/${total}; the worker starts the next one`);
    return;
  }
  await finish(d, q, f);
}

async function finish(d: AutofillDeps, q: QRow, f: QFence): Promise<void> {
  const orgId = q.organization_id;
  const n = await orgTx(d.engine.sql, orgId, async (tx) => {
    const counts = await recount(tx, orgId, q.id);
    const r = await tx`
      UPDATE bastion_questionnaires
         SET status = 'in_review', claimed_by = NULL, heartbeat_at = NULL, slice_token = NULL, rows_done = ${counts.done}, row_count = ${counts.total},
             high_count = ${counts.high}, medium_count = ${counts.medium}, low_count = ${counts.low}
       WHERE id = ${q.id} AND organization_id = ${orgId} AND claimed_by = ${f.claimant} AND slice_token = ${f.token} AND status = 'answering'
      RETURNING id`;
    if (!r[0]) throw new ClaimLostError();
    const actor = q.asker ?? q.created_by;
    const actorKind = actor ? String((await tx`SELECT kind FROM users WHERE id = ${actor}`)[0]?.kind ?? 'human') : 'service';
    await tx`
      INSERT INTO bastion_audit_log (organization_id, actor_id, actor_kind, impersonator_id, action, subject_type, subject_id, details)
      VALUES (${orgId}, ${actor}, ${actorKind}, NULL, 'questionnaire.autofill', 'questionnaire', ${q.id},
              ${tx.json({ rows: counts.total, high: counts.high, medium: counts.medium, low: counts.low } as never)})`;
    // One event per autofill run (#267): a retry of this run's finish() dedupes, a redraft (a new
    // generation) does not, whatever its counts. resume_count was reset by every start, so it
    // repeated across runs and the second run's event was silently dropped.
    const fresh = await enqueueBastionEvent(
      'questionnaire.drafted',
      // #262: the catalog's names; refs and counts only (spec 8.1). The customer-supplied title is
      // deliberately left out of an org-wide event: a rule can read it by id.
      { questionnaire_id: q.id, row_count: counts.total, high_count: counts.high, medium_count: counts.medium, low_count: counts.low },
      tx,
      { orgId, idempotencyKey: `questionnaire.drafted:${q.id}:g${Number(q.autofill_generation)}`, actorId: actor ?? undefined, actorType: actorKind === 'human' ? 'user' : 'agent' },
    );
    if (!fresh) {
      d.engine.log.warn({ questionnaire_id: q.id, generation: q.autofill_generation }, 'bastion-autofill: questionnaire.drafted was already queued for this run; not sent again');
    }
    return counts;
  });
  d.engine.log.info({ questionnaire_id: q.id }, `bastion-autofill: questionnaire '${q.title}' drafted; ${n.total} rows (high ${n.high}, medium ${n.medium}, low ${n.low})`);
}

/* ------------------------------ tick and reaper ------------------------------ */

/** Answering questionnaires nobody is driving (the orphan rule of spec 7): the tick re-enqueues them. */
export async function orphanedQuestionnaires(engine: EngineDeps, olderThan: Date, organizationId?: string) {
  const rows = await engine.sql`
    SELECT id, organization_id, resume_count FROM bastion_questionnaires
     WHERE status = 'answering' AND claimed_by IS NULL AND updated_at < ${olderThan}
       ${organizationId ? engine.sql`AND organization_id = ${organizationId}` : engine.sql``}
     ORDER BY updated_at LIMIT 100`;
  return rows.map((r) => ({ organization_id: String(r.organization_id), questionnaire_id: String(r.id), resume_count: Number(r.resume_count) }));
}

/** Claims whose heartbeat outlived the lease: released (resume_count + 1); at MAX_RESUMES, parked to review. */
export async function reapQuestionnaires(engine: EngineDeps, cutoff: Date, organizationId?: string) {
  const released = await engine.sql`
    UPDATE bastion_questionnaires SET claimed_by = NULL, heartbeat_at = NULL, slice_token = NULL, resume_count = resume_count + 1
     WHERE status = 'answering' AND claimed_by IS NOT NULL AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff})
       ${organizationId ? engine.sql`AND organization_id = ${organizationId}` : engine.sql``}
    RETURNING id, organization_id, resume_count`;
  let parked = 0;
  for (const r of released) {
    if (Number(r.resume_count) < MAX_RESUMES) continue;
    await orgTx(engine.sql, String(r.organization_id), (tx) => parkQuestionnaire(tx, String(r.organization_id), String(r.id)));
    parked += 1;
  }
  return { released: released.length - parked, parked };
}
