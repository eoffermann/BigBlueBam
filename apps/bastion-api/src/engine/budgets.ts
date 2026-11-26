// Time budgets (spec 7.3). test/time-budgets.test.ts asserts the arithmetic: a probe slice that
// stops starting probes at SLICE_START_CUTOFF_MS can still finish one probe, one bucket put and
// one ledger lock wait inside the worker's engine call timeout.

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
/** Run lease: a claim whose heartbeat is older than this may be taken over or released. */
export const RUN_LEASE_MS = 300_000;
/** A 409 naming a claim whose heartbeat is older than this is treated as stale by the worker. */
export const STALE_HEARTBEAT_MS = 60_000;
/** LLM slices (M7/M8): stop starting calls at 150 s including slot waits; worst case 210 s. */
export const LLM_SLICE_START_CUTOFF_MS = 150_000;
export const LLM_CALL_TIMEOUT_MS = 60_000;
/** Above this replica lag (as_of minus last replay), probes run on the primary. */
export const MAX_REPLICA_LAG_MS = 30_000;
/** A queued run idle longer than this is re-enqueued by the tick (orphan rule). */
export const ORPHAN_REQUEUE_AFTER_MS = 120_000;
/** Resumable runs are released at most this many times before they go `partial`. */
export const MAX_RESUMES = 3;

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
