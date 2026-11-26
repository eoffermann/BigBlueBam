// The one place the internal LLM proxy's call deadline lives (#257). The Bam api's
// POST /internal/llm/chat proxy, every satellite that calls it, and every slot or permit that is
// held for the length of one call read these, so a deadline raised for a slow reasoning model can
// never leave a permit or an in-flight slot expiring while its call is still running.

/** The proxy's upstream deadline when a caller does not ask for one (what every call had before #257). */
export const LLM_CALL_TIMEOUT_DEFAULT_MS = 60_000;
/** The longest deadline a caller may ask for; the proxy clamps to it, and satellites refuse to boot above it. */
export const LLM_CALL_TIMEOUT_MAX_MS = 180_000;
/** The shortest deadline a caller may ask for. */
export const LLM_CALL_TIMEOUT_MIN_MS = 1_000;
/** Held slots and permits outlive their call by this much before they count as leaked. */
export const LLM_HOLD_MARGIN_MS = 30_000;
/** How long the caller waits past the proxy's deadline, so the proxy's own timeout answer arrives first. */
export const LLM_CLIENT_GRACE_MS = 5_000;

/** The deadline the proxy applies: the caller's request clamped to [MIN, MAX], else the default. */
export function llmCallDeadlineMs(requestedMs?: number | null): number {
  if (requestedMs === undefined || requestedMs === null || !Number.isFinite(requestedMs)) return LLM_CALL_TIMEOUT_DEFAULT_MS;
  return Math.min(LLM_CALL_TIMEOUT_MAX_MS, Math.max(LLM_CALL_TIMEOUT_MIN_MS, Math.round(requestedMs)));
}

/** How long a slot or permit held for one call of `timeoutMs` may live before it is treated as leaked. */
export function llmHoldWindowMs(timeoutMs: number): number {
  return llmCallDeadlineMs(timeoutMs) + LLM_HOLD_MARGIN_MS;
}

/** The proxy's error code for an upstream call that ran past its deadline (HTTP 504). */
export const LLM_UPSTREAM_TIMEOUT_CODE = 'UPSTREAM_TIMEOUT';
