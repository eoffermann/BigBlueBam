// The LLM-tailored compile (spec 2.1 step 2, 7, 7.3), driven by the worker behind the SAME
// contract as M3's inline compile: POST /frameworks/:id/compile answers 202 with the run. When an
// AI provider resolves for the org (and the caller did not ask for the library only), the run is
// created `queued` and the bastion-compile job drives it through POST /internal/engines/compile;
// otherwise the deterministic compile runs inline exactly as at M3.
//
// Slices are ASYNC-START (spec 7.3): one engine call claims the run (fenced on the worker's
// claimant), starts a slice in the background and answers at once; the worker polls every 15 s.
// A slice stops starting LLM calls at 150 s INCLUDING the wait for a leased permit, heartbeats
// after every call and every 20 s while it waits, and writes each control in its own transaction
// (assertions, progress and heartbeat together, fenced on the claim), so a crash, a deploy or a
// lost claim leaves only whole controls behind and the next slice skips them. On SIGTERM it stops
// starting calls, lets the current one finish and releases the run (queued, resume_count + 1);
// the tick re-enqueues it.
//
// Per control: the model gets the control, the profile, the connected sources and the closed
// probe menu (library/tailoring.ts); its answer goes through the same validator as the library's
// suggestions; when nothing usable comes back, the call fails, or the run's call budget
// (max_llm_calls_per_compile, default 400) is spent, that control gets the library's suggestions
// verbatim. Everything lands as `proposed`; a person confirms.

import type { BastionCompileSlice } from '@bigbluebam/shared';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { LLM_SLICE_START_CUTOFF_MS, MAX_RESUMES, STALE_HEARTBEAT_MS } from '../engine/budgets.js';
import { RunLeaseHeldError, RunNotFoundError } from '../engine/evaluator.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import { LlmError, LlmThrottledError, type LlmChat } from '../lib/llm-errors.js';
import type { LlmPermits } from '../lib/llm-permits.js';
import {
  type ConnectedPopulations,
  type DroppedSuggestion,
  type ExistingAssertionSignature,
  planTailoredControl,
} from '../library/compile-plan.js';
import { libraryControl } from '../library/controls.js';
import { derivedApplicability } from '../library/setup-state.js';
import { buildTailoringMessages, parseTailoringResponse, TAILORING_PROMPT_VERSION, tailoredSuggestions } from '../library/tailoring.js';

export const COMPILE_HEARTBEAT_EVERY_MS = 20_000;
export const COMPILE_PERMIT_RETRY_MS = 2_000;
/** A slice lock outlives the longest slice (150 s + one 60 s call) with margin. */
export const COMPILE_SLICE_LOCK_MS = 240_000;
/** Default cap when the org has no settings row (bastion_org_settings default). */
export const DEFAULT_MAX_LLM_CALLS_PER_COMPILE = 400;

/** Prevents two slices of one run at once, across bastion-api replicas (Redis) and in-process. */
export interface SliceLock {
  acquire(runId: string, ttlMs: number): Promise<boolean>;
  release(runId: string): Promise<void>;
}

export interface CompileAiDeps {
  engine: EngineDeps;
  llm: LlmChat;
  permits: LlmPermits;
  sliceLock: SliceLock;
  /** Production starts the slice and answers at once; the tests await it. */
  background: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** True once SIGTERM arrived: stop starting calls and release the run. */
  shuttingDown?: () => boolean;
  sliceCutoffMs?: number;
}

/** What the run row carries in drop_reasons while it runs (and after). */
export interface CompileProgress {
  mode: 'ai';
  provider_id: string | null;
  prompt_version: number;
  items: DroppedSuggestion[];
  skipped_existing: number;
  done_keys: string[];
  fallback_keys: string[];
  not_applicable: Array<{ control_key: string; ref_code: string; reason: string }>;
  withheld_labels: number;
}

function progressOf(raw: unknown, providerId: string | null): CompileProgress {
  const p = (raw ?? {}) as Partial<CompileProgress>;
  return {
    mode: 'ai',
    provider_id: p.provider_id ?? providerId,
    prompt_version: p.prompt_version ?? TAILORING_PROMPT_VERSION,
    items: Array.isArray(p.items) ? p.items : [],
    skipped_existing: Number(p.skipped_existing ?? 0),
    done_keys: Array.isArray(p.done_keys) ? p.done_keys : [],
    fallback_keys: Array.isArray(p.fallback_keys) ? p.fallback_keys : [],
    not_applicable: Array.isArray(p.not_applicable) ? p.not_applicable : [],
    withheld_labels: Number(p.withheld_labels ?? 0),
  };
}

/* ------------------------------ provider ------------------------------ */

/**
 * The AI provider for this org, resolved like the platform's resolveProvider: the one chosen in
 * Bastion's settings (if it is still enabled and visible to the org), else the org's default,
 * else the system default; null means "no AI", and the compile runs the deterministic fallback.
 */
export async function resolveLlmProviderId(tx: Tx, orgId: string): Promise<string | null> {
  const chosen = (await tx`
    SELECT p.id FROM bastion_org_settings s
      JOIN llm_providers p ON p.id = s.llm_provider_id
     WHERE s.organization_id = ${orgId} AND p.enabled
       AND ((p.scope = 'organization' AND p.organization_id = ${orgId}) OR (p.scope = 'system' AND p.organization_id IS NULL))`)[0];
  if (chosen) return String(chosen.id);
  const fallback = (await tx`
    SELECT id FROM llm_providers
     WHERE enabled AND ((scope = 'organization' AND organization_id = ${orgId}) OR (scope = 'system' AND organization_id IS NULL))
     ORDER BY (scope = 'organization') DESC, is_default DESC, created_at
     LIMIT 1`)[0];
  return fallback ? String(fallback.id) : null;
}

/** The connected sets population probes draw from (raw twin of services/shared.ts connectedPopulations). */
export async function connectedPopulationsRaw(tx: Tx, orgId: string): Promise<ConnectedPopulations> {
  const repos = await tx`
    SELECT DISTINCT lower(gi.repo_owner || '/' || gi.repo_name) AS value, gi.repo_owner || '/' || gi.repo_name AS label
      FROM github_integrations gi
      JOIN projects p ON p.id = gi.project_id
     WHERE p.org_id = ${orgId} AND gi.enabled
     ORDER BY 1`;
  const apps = await tx`SELECT a.id::text AS value, a.name AS label FROM blip_tracked_apps a WHERE a.org_id = ${orgId} ORDER BY a.name`;
  return {
    github_repos: repos.map((r) => ({ value: String(r.value), label: String(r.label) })),
    blip_apps: apps.map((a) => ({ value: String(a.value), label: String(a.label) })),
  };
}

/* ------------------------------ queueing ------------------------------ */

/** Create the queued run for the worker (the route answers 202 with it). Throws 23505 on a running compile. */
export async function createQueuedAiRun(tx: Tx, orgId: string, frameworkId: string, startedBy: string, providerId: string) {
  const progress: CompileProgress = progressOf({}, providerId);
  const r = await tx`
    INSERT INTO bastion_compile_runs (organization_id, framework_id, status, used_fallback, drop_reasons, started_by)
    VALUES (${orgId}, ${frameworkId}, 'queued', false, ${tx.json(progress as never)}, ${startedBy})
    RETURNING *`;
  const row = r[0];
  if (!row) throw new Error('bastion_compile_runs insert returned no row');
  return row;
}

/* ------------------------------ the engine ------------------------------ */

interface RunRow {
  id: string;
  organization_id: string;
  framework_id: string;
  status: string;
  claimed_by: string | null;
  heartbeat_at: string | Date | null;
  controls_total: number;
  controls_done: number;
  assertions_proposed: number;
  assertions_dropped: number;
  llm_calls_used: number;
  resume_count: number;
  started_by: string | null;
  drop_reasons: unknown;
}

const active = new Map<string, Promise<void>>();
const waitingState = new Map<string, 'ai_slot' | 'ai_throttled' | null>();
let stopping = false;

/** SIGTERM: stop starting LLM calls (spec 7.3). */
export function markCompileShuttingDown(): void {
  stopping = true;
}

/** Wait for in-flight slices (each finishes its current call, then releases its run). */
export async function drainCompileSlices(timeoutMs: number): Promise<number> {
  const pending = [...active.values()];
  if (pending.length === 0) return 0;
  await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
  return pending.length;
}

function sliceView(run: RunRow, running: boolean, extra: Partial<BastionCompileSlice> = {}): BastionCompileSlice {
  const p = progressOf(run.drop_reasons, null);
  return {
    done: ['succeeded', 'failed', 'partial'].includes(run.status),
    status: run.status as BastionCompileSlice['status'],
    controls_done: Number(run.controls_done),
    controls_total: Number(run.controls_total),
    assertions_proposed: Number(run.assertions_proposed),
    assertions_dropped: Number(run.assertions_dropped),
    llm_calls_used: Number(run.llm_calls_used),
    fallback_controls: p.fallback_keys.length,
    slice_running: running,
    waiting: waitingState.get(run.id) ?? null,
    ...extra,
  };
}

async function readRun(d: CompileAiDeps, orgId: string, runId: string): Promise<RunRow | null> {
  const r = await orgTx(d.engine.sql, orgId, (tx) => tx`SELECT * FROM bastion_compile_runs WHERE organization_id = ${orgId} AND id = ${runId}`);
  return (r[0] as unknown as RunRow | undefined) ?? null;
}

/**
 * POST /internal/engines/compile: claim the run for `claimant` and start (or report on) a slice.
 * 404 RunNotFoundError; 409 RunLeaseHeldError when another live claimant holds it.
 */
export async function compileSlice(d: CompileAiDeps, body: { organization_id: string; run_id: string; claimant: string }): Promise<BastionCompileSlice> {
  const { organization_id: orgId, run_id: runId, claimant } = body;
  const run = await readRun(d, orgId, runId);
  if (!run) throw new RunNotFoundError();
  if (['succeeded', 'failed', 'partial'].includes(run.status)) return sliceView(run, false);
  if (active.has(runId)) return sliceView(run, true);

  const now = d.engine.now();
  const takeoverBefore = new Date(now.getTime() - d.engine.leaseMs);
  const claimed = await orgTx(d.engine.sql, orgId, (tx) => tx`
    UPDATE bastion_compile_runs
       SET status = 'running', claimed_by = ${claimant}, heartbeat_at = ${now}, started_at = coalesce(started_at, ${now})
     WHERE organization_id = ${orgId} AND id = ${runId} AND status IN ('queued', 'running')
       AND claimed_by IS DISTINCT FROM 'bastion-api:inline'
       AND (claimed_by IS NULL OR claimed_by = ${claimant} OR heartbeat_at IS NULL OR heartbeat_at < ${takeoverBefore})
    RETURNING *`);
  if (!claimed[0]) {
    const cur = await readRun(d, orgId, runId);
    if (!cur) throw new RunNotFoundError();
    if (['succeeded', 'failed', 'partial'].includes(cur.status)) return sliceView(cur, false);
    const stale = !cur.heartbeat_at || now.getTime() - new Date(cur.heartbeat_at).getTime() > STALE_HEARTBEAT_MS;
    throw new RunLeaseHeldError(cur.claimed_by, stale);
  }
  const mine = claimed[0] as unknown as RunRow;
  if (!(await d.sliceLock.acquire(runId, COMPILE_SLICE_LOCK_MS).catch(() => true))) return sliceView(mine, true);

  const slice = runSlice(d, mine, claimant)
    .catch((err) => {
      d.engine.log.error({ run_id: runId, err: (err as Error).message }, 'bastion-compile: slice failed');
    })
    .finally(async () => {
      active.delete(runId);
      waitingState.delete(runId);
      await d.sliceLock.release(runId).catch(() => undefined);
    });
  active.set(runId, slice);
  if (!d.background) {
    await slice;
    const after = await readRun(d, orgId, runId);
    return sliceView(after ?? mine, false);
  }
  return sliceView(mine, true);
}

class ClaimLostError extends Error {
  constructor() {
    super('the compile run was taken over by another claimant');
    this.name = 'ClaimLostError';
  }
}

interface ControlToPlan {
  id: string;
  control_key: string;
  requirements: Array<{ ref_code: string; title: string }>;
}

async function loadPlanContext(tx: Tx, orgId: string, frameworkId: string) {
  const fw = (await tx`SELECT id, name, status FROM bastion_frameworks WHERE organization_id = ${orgId} AND id = ${frameworkId}`)[0];
  const links = await tx`
    SELECT control_id, framework_id, ref_code, requirement_title, applicability, removed_at
      FROM bastion_control_requirements WHERE organization_id = ${orgId}`;
  const controls = await tx`SELECT id, control_key, lifecycle FROM bastion_controls WHERE organization_id = ${orgId} ORDER BY control_key`;
  const settings = (await tx`SELECT company_profile, max_llm_calls_per_compile FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  const inFramework = new Set(links.filter((l) => l.framework_id === frameworkId && !l.removed_at).map((l) => String(l.control_id)));
  const out: ControlToPlan[] = [];
  for (const c of controls) {
    const id = String(c.id);
    if (c.lifecycle !== 'active' || !inFramework.has(id)) continue;
    const mine = links.filter((l) => String(l.control_id) === id);
    const shaped = mine.map((l) => ({ applicability: String(l.applicability), removed_at: l.removed_at as string | null }));
    if (derivedApplicability(shaped as never) !== 'applicable') continue;
    out.push({
      id,
      control_key: String(c.control_key),
      requirements: mine
        .filter((l) => String(l.framework_id) === frameworkId && !l.removed_at)
        .map((l) => ({ ref_code: String(l.ref_code), title: String(l.requirement_title ?? '') })),
    });
  }
  return {
    framework: fw ? { id: String(fw.id), name: String(fw.name), status: String(fw.status) } : null,
    controls: out,
    profile: (settings?.company_profile as Record<string, unknown> | null) ?? {},
    maxCalls: Number(settings?.max_llm_calls_per_compile ?? DEFAULT_MAX_LLM_CALLS_PER_COMPILE),
  };
}

async function heartbeat(d: CompileAiDeps, run: RunRow, claimant: string): Promise<void> {
  const r = await orgTx(d.engine.sql, run.organization_id, (tx) => tx`
    UPDATE bastion_compile_runs SET heartbeat_at = ${d.engine.now()}
     WHERE id = ${run.id} AND organization_id = ${run.organization_id} AND claimed_by = ${claimant} AND status = 'running'
    RETURNING id`);
  if (!r[0]) throw new ClaimLostError();
}

async function releaseRun(d: CompileAiDeps, run: RunRow, claimant: string): Promise<void> {
  await orgTx(d.engine.sql, run.organization_id, (tx) => tx`
    UPDATE bastion_compile_runs
       SET status = CASE WHEN resume_count + 1 >= ${MAX_RESUMES} THEN 'partial' ELSE 'queued' END,
           error = CASE WHEN resume_count + 1 >= ${MAX_RESUMES} THEN 'Setup stopped several times before it finished. Start it again from Setup.' ELSE error END,
           claimed_by = NULL, heartbeat_at = NULL, resume_count = resume_count + 1
     WHERE id = ${run.id} AND organization_id = ${run.organization_id} AND claimed_by = ${claimant} AND status = 'running'`);
}

type AiOutcome =
  | { kind: 'answer'; content: string; finish_reason: string | null; withheld: number }
  | { kind: 'fallback'; reason: string }
  | { kind: 'out_of_time' };

/** One AI call for one control, waiting for a leased permit within the slice budget. */
async function askAi(
  d: CompileAiDeps,
  run: RunRow,
  claimant: string,
  providerId: string,
  messages: ReturnType<typeof buildTailoringMessages>,
  sliceStart: number,
  cutoff: number,
): Promise<AiOutcome> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastBeat = Date.now();
  let first = true;
  for (;;) {
    // The caller decided to start this control; only WAITING (for a permit, or after a 429) is
    // bounded by the slice cutoff here, so every slice makes progress when a permit is free.
    if (!first && Date.now() - sliceStart > cutoff) return { kind: 'out_of_time' };
    first = false;
    if (stopping || d.shuttingDown?.()) return { kind: 'out_of_time' };
    const admission = await d.permits.tryAdmit(run.organization_id);
    if (!admission.admitted) {
      if (waitingState.get(run.id) !== 'ai_slot') {
        d.engine.log.info({ run_id: run.id }, 'bastion-compile: waiting for an AI slot (org limit 1)');
      }
      waitingState.set(run.id, 'ai_slot');
      if (Date.now() - lastBeat >= COMPILE_HEARTBEAT_EVERY_MS) {
        await heartbeat(d, run, claimant);
        lastBeat = Date.now();
      }
      await sleep(COMPILE_PERMIT_RETRY_MS);
      continue;
    }
    waitingState.set(run.id, null);
    try {
      const res = await d.llm({ providerId, messages: messages.messages, maxTokens: 2048 });
      return { kind: 'answer', content: res.content, finish_reason: res.finish_reason, withheld: messages.withheld_labels };
    } catch (err) {
      if (err instanceof LlmThrottledError) {
        waitingState.set(run.id, 'ai_throttled');
        const wait = Math.min(err.retryAfterSeconds, 30) * 1000;
        d.engine.log.info({ run_id: run.id }, `bastion-compile: throttled by the AI provider, resuming in ${Math.round(wait / 1000)} s`);
        await admission.release(); // give the permit back while we wait (finally releases again: a no-op)
        await sleep(wait);
        continue;
      }
      return { kind: 'fallback', reason: err instanceof LlmError ? `the AI call failed (${err.message})` : 'the AI call failed' };
    } finally {
      await admission.release();
    }
  }
}

async function runSlice(d: CompileAiDeps, run: RunRow, claimant: string): Promise<void> {
  const sliceStart = Date.now();
  const cutoff = d.sliceCutoffMs ?? LLM_SLICE_START_CUTOFF_MS;
  const orgId = run.organization_id;
  const ctx = await orgTx(d.engine.sql, orgId, (tx) => loadPlanContext(tx, orgId, run.framework_id));
  if (!ctx.framework || ctx.framework.status === 'archived') {
    await orgTx(d.engine.sql, orgId, (tx) => tx`
      UPDATE bastion_compile_runs SET status = 'failed', error = 'The framework was archived or removed.', completed_at = ${d.engine.now()}, claimed_by = NULL
       WHERE id = ${run.id} AND claimed_by = ${claimant}`);
    return;
  }
  const populations = await orgTx(d.engine.sql, orgId, (tx) => connectedPopulationsRaw(tx, orgId));
  let progress = progressOf(run.drop_reasons, null);
  const providerId = progress.provider_id ?? (await orgTx(d.engine.sql, orgId, (tx) => resolveLlmProviderId(tx, orgId)));
  let calls = Number(run.llm_calls_used);
  const total = ctx.controls.length;
  const name = ctx.framework.name;
  d.engine.log.info(
    { run_id: run.id, resume_count: run.resume_count },
    `bastion-compile: framework '${name}' slice starting; controls ${progress.done_keys.length}/${total} llm_calls ${calls} (a call takes 10-20 s; a whole compile 1-2 hours)`,
  );
  if (Number(run.controls_total) !== total) {
    await orgTx(d.engine.sql, orgId, (tx) => tx`UPDATE bastion_compile_runs SET controls_total = ${total} WHERE id = ${run.id} AND claimed_by = ${claimant}`);
  }

  const done = new Set(progress.done_keys);
  let processed = 0;
  for (const c of ctx.controls) {
    if (done.has(c.control_key)) continue;
    if (stopping || d.shuttingDown?.()) {
      await releaseRun(d, run, claimant);
      d.engine.log.info({ run_id: run.id }, 'bastion-compile: shutting down; the run was released and will resume');
      return;
    }
    // Stop starting controls at the cutoff (spec 7.3), but always do at least one per slice.
    if (processed > 0 && Date.now() - sliceStart > cutoff) break;
    processed += 1;
    const lib = libraryControl(c.control_key);

    // Ask the AI (outside any transaction), unless there is no provider, no library entry to
    // tailor, or the run's call budget is spent.
    let tailored: Parameters<typeof planTailoredControl>[1] = null;
    let fallbackReason: string | null = null;
    let withheld = 0;
    if (!lib) fallbackReason = null;
    else if (!providerId) fallbackReason = 'no AI provider is set up, so the library suggestions were proposed';
    else if (calls >= ctx.maxCalls) fallbackReason = `the AI call budget for this run (${ctx.maxCalls}) was used up, so the library suggestions were proposed`;
    else {
      const messages = buildTailoringMessages({ control: lib, requirements: c.requirements, profile: ctx.profile, connected: populations });
      const outcome = await askAi(d, run, claimant, providerId, messages, sliceStart, cutoff);
      if (outcome.kind === 'out_of_time') {
        if (stopping || d.shuttingDown?.()) {
          await releaseRun(d, run, claimant);
          return;
        }
        break;
      }
      calls += 1;
      if (outcome.kind === 'fallback') fallbackReason = outcome.reason;
      else {
        withheld = outcome.withheld;
        const parsed = parseTailoringResponse(outcome.content, outcome.finish_reason);
        if (parsed.ok) tailored = tailoredSuggestions(c.control_key, parsed.value, { requirements: c.requirements, connected: populations, control: lib });
        else fallbackReason = `${parsed.reason}, so the library suggestions were proposed`;
      }
    }

    // One transaction per control: re-read what the control has, plan, insert, record progress.
    const written = await orgTx(d.engine.sql, orgId, async (tx) => {
      const existing = await tx`
        SELECT kind, probe_key, manual_evidence_spec, review_status FROM bastion_assertions
         WHERE organization_id = ${orgId} AND control_id = ${c.id}`;
      const sigs: ExistingAssertionSignature[] = existing.map((e) => ({
        control_key: c.control_key,
        kind: String(e.kind),
        probe_key: (e.probe_key as string | null) ?? null,
        manual_title: ((e.manual_evidence_spec as { title?: string } | null)?.title as string | undefined) ?? null,
        review_status: String(e.review_status),
      }));
      const plan = lib ? planTailoredControl(c.control_key, tailored, sigs, populations, fallbackReason) : { planned: [], dropped: [], skipped_existing: 0, not_applicable: [], used_fallback: false };
      for (const p of plan.planned) {
        await tx`
          INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate, manual_evidence_spec,
                                          plain_statement, proposed_by, compile_run_id, review_status, created_by)
          VALUES (${orgId}, ${c.id}, ${p.kind}, ${p.probe_key}, ${p.probe_version}, ${tx.json(p.params as never)}, ${tx.json(p.predicate as never)},
                  ${p.manual_evidence_spec ? tx.json(p.manual_evidence_spec as never) : null}, ${p.plain_statement}, ${p.proposed_by ?? 'library'},
                  ${run.id}, 'proposed', ${run.started_by})`;
      }
      progress = {
        ...progress,
        provider_id: providerId,
        items: [...progress.items, ...plan.dropped].slice(-500),
        skipped_existing: progress.skipped_existing + plan.skipped_existing,
        done_keys: [...progress.done_keys, c.control_key],
        fallback_keys: plan.used_fallback ? [...progress.fallback_keys, c.control_key] : progress.fallback_keys,
        not_applicable: [...progress.not_applicable, ...plan.not_applicable.map((n) => ({ control_key: c.control_key, ...n }))],
        withheld_labels: progress.withheld_labels + withheld,
      };
      const upd = await tx`
        UPDATE bastion_compile_runs
           SET controls_done = ${progress.done_keys.length}, assertions_proposed = assertions_proposed + ${plan.planned.length},
               assertions_dropped = assertions_dropped + ${plan.dropped.length}, llm_calls_used = ${calls},
               drop_reasons = ${tx.json(progress as never)}, heartbeat_at = ${d.engine.now()}
         WHERE id = ${run.id} AND organization_id = ${orgId} AND claimed_by = ${claimant} AND status = 'running'
        RETURNING assertions_proposed, assertions_dropped`;
      if (!upd[0]) throw new ClaimLostError();
      return { planned: plan.planned.length, dropped: plan.dropped.length, proposed_total: Number(upd[0].assertions_proposed), dropped_total: Number(upd[0].assertions_dropped) };
    });
    done.add(c.control_key);
    d.engine.log.info(
      { run_id: run.id },
      `bastion-compile: framework '${name}' controls ${done.size}/${total} proposed ${written.proposed_total} dropped ${written.dropped_total} llm_calls ${calls} fallback=${progress.fallback_keys.length > 0} elapsed_ms=${Date.now() - sliceStart}`,
    );
  }

  if (done.size < total) {
    d.engine.log.info({ run_id: run.id }, `bastion-compile: slice ended at ${done.size}/${total}; the worker starts the next one`);
    return;
  }
  await finishRun(d, run, claimant, progress, total);
}

async function finishRun(d: CompileAiDeps, run: RunRow, claimant: string, progress: CompileProgress, total: number): Promise<void> {
  const orgId = run.organization_id;
  const allFallback = total > 0 && progress.fallback_keys.length === total;
  await orgTx(d.engine.sql, orgId, async (tx) => {
    const r = await tx`
      UPDATE bastion_compile_runs
         SET status = 'succeeded', used_fallback = ${allFallback}, completed_at = ${d.engine.now()}, heartbeat_at = ${d.engine.now()}
       WHERE id = ${run.id} AND organization_id = ${orgId} AND claimed_by = ${claimant} AND status = 'running'
      RETURNING assertions_proposed, assertions_dropped, llm_calls_used`;
    const row = r[0];
    if (!row) throw new ClaimLostError();
    await tx`UPDATE bastion_frameworks SET status = 'active' WHERE id = ${run.framework_id} AND organization_id = ${orgId} AND status = 'compiling'`;
    const actorKind = run.started_by ? String((await tx`SELECT kind FROM users WHERE id = ${run.started_by}`)[0]?.kind ?? 'human') : 'service';
    await tx`
      INSERT INTO bastion_audit_log (organization_id, actor_id, actor_kind, impersonator_id, action, subject_type, subject_id, details)
      VALUES (${orgId}, ${run.started_by}, ${actorKind}, NULL, 'framework.compile', 'compile_run', ${run.id},
              ${tx.json({ framework_id: run.framework_id, assertions_proposed: Number(row.assertions_proposed), assertions_dropped: Number(row.assertions_dropped), llm_calls_used: Number(row.llm_calls_used), used_fallback: allFallback, fallback_controls: progress.fallback_keys.length, mode: 'ai' } as never)})`;
    await enqueueBastionEvent(
      'assertions.compiled',
      {
        compile_run_id: run.id,
        framework_id: run.framework_id,
        assertions_proposed: Number(row.assertions_proposed),
        assertions_dropped: Number(row.assertions_dropped),
        used_fallback: allFallback,
      },
      tx,
      { orgId, idempotencyKey: `assertions.compiled:${run.id}`, actorId: run.started_by ?? undefined, actorType: actorKind === 'human' ? 'user' : 'agent' },
    );
  });
  d.engine.log.info({ run_id: run.id }, `bastion-compile: run finished; ${total} controls, ${progress.fallback_keys.length} on the library suggestions`);
}

/* ------------------------------ tick and reaper ------------------------------ */

/** Queued AI compile runs nobody is driving (the orphan rule of spec 7): the tick re-enqueues them. */
export async function orphanedCompileRuns(engine: EngineDeps, olderThan: Date, organizationId?: string) {
  const rows = await engine.sql`
    SELECT id, organization_id, resume_count FROM bastion_compile_runs
     WHERE status = 'queued' AND claimed_by IS NULL AND updated_at < ${olderThan}
       ${organizationId ? engine.sql`AND organization_id = ${organizationId}` : engine.sql``}
     ORDER BY updated_at LIMIT 100`;
  return rows.map((r) => ({ organization_id: String(r.organization_id), run_id: String(r.id), resume_count: Number(r.resume_count) }));
}

/**
 * Worker-claimed compile runs whose heartbeat outlived the lease: released to `queued` with
 * resume_count + 1, up to MAX_RESUMES; only then `partial`. Inline claims are never touched here
 * (the reaper fails those, issue #193).
 */
export async function reapCompileRuns(engine: EngineDeps, cutoff: Date, organizationId?: string) {
  const released = await engine.sql`
    UPDATE bastion_compile_runs
       SET status = 'queued', claimed_by = NULL, heartbeat_at = NULL, resume_count = resume_count + 1
     WHERE status = 'running' AND claimed_by IS NOT NULL AND claimed_by <> 'bastion-api:inline'
       AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff}) AND resume_count < ${MAX_RESUMES}
       ${organizationId ? engine.sql`AND organization_id = ${organizationId}` : engine.sql``}
    RETURNING id`;
  const parked = await engine.sql`
    UPDATE bastion_compile_runs
       SET status = 'partial', claimed_by = NULL, completed_at = ${engine.now()},
           error = 'Setup stopped several times before it finished. Start it again from Setup.'
     WHERE status = 'running' AND claimed_by IS NOT NULL AND claimed_by <> 'bastion-api:inline'
       AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff}) AND resume_count >= ${MAX_RESUMES}
       ${organizationId ? engine.sql`AND organization_id = ${organizationId}` : engine.sql``}
    RETURNING id`;
  return { released: released.length, parked: parked.length };
}
