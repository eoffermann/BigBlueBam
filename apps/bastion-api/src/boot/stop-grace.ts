import { llmCallDrainMs, platformStopGrace, stopGraceNeededMs, stopGraceProblem } from '@bigbluebam/shared';
import { ENGINE_TIMEOUT_MS } from '../engine/budgets.js';

// bastion-api's shutdown must fit the platform's stop grace (#284). No env import, so env.ts can
// call it at boot and the unit tests can call it directly.

/**
 * Null when the platform stop grace covers bastion-api's shutdown: the HTTP close (an evaluation
 * slice, at most ENGINE_TIMEOUT_MS) and the AI drain (llmCallDrainMs of the deadline) run side by
 * side from the signal (main.ts), then SHUTDOWN_EXIT_MARGIN_MS for queues and pools. Otherwise the
 * plain sentence that names the setting to raise.
 */
export function bastionStopGraceProblem(e: {
  BASTION_LLM_TIMEOUT_MS: number;
  STOP_GRACE_SECONDS?: string;
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS?: string;
}): string | null {
  const grace = platformStopGrace({ STOP_GRACE_SECONDS: e.STOP_GRACE_SECONDS, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: e.RAILWAY_DEPLOYMENT_DRAINING_SECONDS });
  const needed = stopGraceNeededMs(ENGINE_TIMEOUT_MS, llmCallDrainMs(e.BASTION_LLM_TIMEOUT_MS));
  const problem = stopGraceProblem(grace, needed, `An AI call at BASTION_LLM_TIMEOUT_MS=${e.BASTION_LLM_TIMEOUT_MS}`);
  return problem && grace.source !== 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS'
    ? `${problem} (In .env that is BASTION_STOP_GRACE_SECONDS.)`
    : problem;
}
