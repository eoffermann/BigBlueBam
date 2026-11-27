// The drain/grace relationship for services that hold in-flight LLM calls (#284, #294): one fact.
//
// When a container is stopped, the platform sends SIGTERM and kills the process after a grace
// period: compose's stop_grace_period, or Railway's RAILWAY_DEPLOYMENT_DRAINING_SECONDS. A
// service that lets its in-flight LLM calls finish on SIGTERM needs that grace to be at least as
// long as its drain, or the kill lands mid-call: the call that was paid for is lost and anything it
// held (a proxy slot, a compile run) is left for a lease or purge window to clean up.
//
// So the drain is DERIVED from the call deadline (llm-deadline.ts), the grace is READ from the
// environment the platform also reads, and each service compares the two at boot.

import { LLM_CLIENT_GRACE_MS, llmCallDeadlineMs } from './llm-deadline.js';

/** The platform grace when nothing says otherwise (compose and Railway defaults in this repo). */
export const STOP_GRACE_DEFAULT_SECONDS = 75;
/** Time kept after the drain for closing queues and database pools before the kill. */
export const SHUTDOWN_EXIT_MARGIN_MS = 5_000;

export interface StopGrace {
  ms: number;
  /** The variable the grace came from, named in boot errors so the operator knows what to raise. */
  source: 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS' | 'STOP_GRACE_SECONDS' | 'default';
}

function seconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The grace the platform gives this process between SIGTERM and the kill. On Railway that is
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS (the platform reads the same variable); under compose it is
 * STOP_GRACE_SECONDS, which compose sets from the same value as the service's stop_grace_period.
 */
export function platformStopGrace(env: Record<string, string | undefined>): StopGrace {
  const railway = seconds(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS);
  if (railway !== null) return { ms: railway * 1000, source: 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS' };
  const own = seconds(env.STOP_GRACE_SECONDS);
  if (own !== null) return { ms: own * 1000, source: 'STOP_GRACE_SECONDS' };
  return { ms: STOP_GRACE_DEFAULT_SECONDS * 1000, source: 'default' };
}

/** How long one in-flight call of this deadline may still need: the deadline plus the client grace. */
export function llmCallDrainMs(timeoutMs?: number | null): number {
  return llmCallDeadlineMs(timeoutMs) + LLM_CLIENT_GRACE_MS;
}

/**
 * The grace a shutdown needs when these phases run side by side from SIGTERM (each budget is
 * measured from the signal): the longest of them, plus the exit margin.
 */
export function stopGraceNeededMs(...budgetsMs: number[]): number {
  return Math.max(0, ...budgetsMs) + SHUTDOWN_EXIT_MARGIN_MS;
}

/**
 * Null when `grace` covers `neededMs`; otherwise the plain sentence to log or refuse boot with,
 * naming the variable to raise and the smallest value that works.
 */
export function stopGraceProblem(grace: StopGrace, neededMs: number, what: string): string | null {
  if (grace.ms >= neededMs) return null;
  const need = Math.ceil(neededMs / 1000);
  const where =
    grace.source === 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS'
      ? 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS on this Railway service'
      : "STOP_GRACE_SECONDS and the service's stop_grace_period (docker-compose.yml)";
  return `${what} needs ${need} s to finish after a stop signal, but the platform gives ${Math.round(grace.ms / 1000)} s (${grace.source}). Raise ${where} to at least ${need}, or lower the deadline.`;
}
