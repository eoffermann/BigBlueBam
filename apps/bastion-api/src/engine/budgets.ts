// Time budgets (spec 7.3). test/time-budgets.test.ts asserts the arithmetic: a probe slice that
// stops starting probes at SLICE_START_CUTOFF_MS can still finish one probe, one bucket put and
// one ledger lock wait inside the worker's engine call timeout.

import { LLM_CALL_TIMEOUT_DEFAULT_MS, LLM_CALL_TIMEOUT_MAX_MS } from '@bigbluebam/shared';

/** Stop starting probes once a slice has run this long. */
export const SLICE_START_CUTOFF_MS = 12_000;
/** Default per-probe statement timeout (BASTION_PROBE_TIMEOUT_MS). */
export const PROBE_TIMEOUT_MS = 8_000;
/** Bucket put timeout per assertion (BASTION_PUT_TIMEOUT_MS). */
export const PUT_TIMEOUT_MS = 5_000;
/** SET LOCAL lock_timeout for the per-org ledger advisory lock. */
export const LEDGER_LOCK_TIMEOUT_MS = 3_000;
/** The worker's bound on one engine call (BASTION_ENGINE_TIMEOUT_MS). */
export const ENGINE_TIMEOUT_MS = 30_000;
/** Headroom past the write for what no timeout bounds: the heartbeat, finish()'s counts, the reply. */
export const SLICE_TAIL_MARGIN_MS = 2_000;
/**
 * Do not START writing a snapshot after this point in a slice. The start cutoff alone does not
 * bound a probe that waited for an engine connection (that wait is not under the statement
 * timeout), so a probe that comes back this late is discarded and re-run in the next slice
 * rather than written past the worker's engine timeout (issue #201).
 */
export const SLICE_WRITE_CUTOFF_MS = ENGINE_TIMEOUT_MS - PUT_TIMEOUT_MS - LEDGER_LOCK_TIMEOUT_MS - SLICE_TAIL_MARGIN_MS;
// ── evidence-ingest copies (#222) ─────────────────────────────────────────────────────────
/** evidence-ingest stops STARTING pending-scan retries once a call has run this long. */
export const EVIDENCE_INGEST_START_CUTOFF_MS = 20_000;
/** Conservative bucket-to-bucket throughput used to decide whether a copy fits the call. */
export const EVIDENCE_COPY_MIN_BYTES_PER_SEC = 2 * 1024 * 1024;
/** Fixed cost of one copy (GET + PUT round-trips) on top of its bytes. */
export const EVIDENCE_COPY_FIXED_MS = 1_000;
/** Reserved after a copy for its transaction (ledger lock wait, writes) and the reply. */
export const EVIDENCE_COPY_WRITE_RESERVE_MS = LEDGER_LOCK_TIMEOUT_MS + SLICE_TAIL_MARGIN_MS + 2_000;
/** The longest any single copy may run (spec 3.3: files up to 100 MB). */
export const EVIDENCE_COPY_TIMEOUT_MS = 120_000;
/**
 * A copy claims its item for this long (next_attempt_at pushed forward before the copy starts),
 * so a worker retry, the next tick or another replica never starts a second copy of the same file.
 */
export const EVIDENCE_COPY_LEASE_MS = EVIDENCE_COPY_TIMEOUT_MS + 60_000;

/** Estimated wall time of copying `bytes` at the conservative throughput. */
export function estimateCopyMs(bytes: number): number {
  return EVIDENCE_COPY_FIXED_MS + Math.ceil((Math.max(0, bytes) * 1000) / EVIDENCE_COPY_MIN_BYTES_PER_SEC);
}

/** Time left for a copy started `elapsedMs` into an engine call, keeping the write reserve. */
export function evidenceCopyBudgetMs(elapsedMs: number): number {
  return Math.max(0, ENGINE_TIMEOUT_MS - elapsedMs - EVIDENCE_COPY_WRITE_RESERVE_MS);
}

/** Run lease: a claim whose heartbeat is older than this may be taken over or released. */
export const RUN_LEASE_MS = 300_000;
/** A 409 naming a claim whose heartbeat is older than this is treated as stale by the worker. */
export const STALE_HEARTBEAT_MS = 60_000;
/** LLM slices (M7/M8): stop starting calls at 150 s including slot waits; worst case 210 s. */
export const LLM_SLICE_START_CUTOFF_MS = 150_000;
/** The default AI call deadline: the platform's one value (packages/shared llm-deadline.ts, #257). */
export const LLM_CALL_TIMEOUT_MS = LLM_CALL_TIMEOUT_DEFAULT_MS;
/** The longest deadline BASTION_LLM_TIMEOUT_MS may be set to (refused at boot above it). */
export { LLM_CALL_TIMEOUT_MAX_MS };
/** Above this replica lag (as_of minus last replay), probes run on the primary. */
export const MAX_REPLICA_LAG_MS = 30_000;
/** A queued run idle longer than this is re-enqueued by the tick (orphan rule). */
export const ORPHAN_REQUEUE_AFTER_MS = 120_000;
/** Resumable runs are released at most this many times before they go `partial`. */
export const MAX_RESUMES = 3;
/**
 * LLM slices (compile, autofill) released after a transient database error do not count against
 * MAX_RESUMES, up to this many per run (#295); past it a release counts as usual, so a database
 * that keeps failing still parks the run.
 */
export const TRANSIENT_RELEASE_LIMIT = 10;

/** The worker's evaluate-run poll loop (spec 7). */
export const EVALUATE_POLL_INTERVAL_MS = 10_000;
export const EVALUATE_MAX_POLLS = 540;

export function worstCaseProbeSliceMs(
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  putTimeoutMs = PUT_TIMEOUT_MS,
  lockTimeoutMs = LEDGER_LOCK_TIMEOUT_MS,
): number {
  return SLICE_START_CUTOFF_MS + probeTimeoutMs + putTimeoutMs + lockTimeoutMs;
}
