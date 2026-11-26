import { callInternalLlm } from '@bigbluebam/shared/internal-llm-client';
import { env } from '../env.js';
import { LlmThrottledError, LlmError, LlmMalformedError, LlmTimeoutError } from './llm-errors.js';

// Re-export so existing importers of the client keep the error classes.
export { LlmThrottledError, LlmError, LlmMalformedError, LlmTimeoutError };

/**
 * The one place bursar-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * through the shared client (@bigbluebam/shared/internal-llm-client, #283), which builds the body
 * from the shared request contract and sends the deadline as timeout_ms.
 *
 *   1. `X-Internal-Service: bursar` keys the proxy's per-service concurrency bucket independently.
 *   2. The deadline is `BURSAR_LLM_TIMEOUT_MS` (default 60000, spec 3.9: long enough for a
 *      leveling chunk). It is SENT to the proxy, which applies the same deadline upstream; env.ts
 *      refuses at boot a value above the proxy's LLM_CALL_TIMEOUT_MAX_MS (180 s). The proxy's
 *      in-flight slot for the call is held for that deadline plus LLM_HOLD_MARGIN_MS.
 *
 * Typed failure modes the engine branches on:
 *   - LlmThrottledError (HTTP 429 concurrency cap): DEFER. The derivation slice releases its
 *     claim and re-throws so a retry resumes from the checkpoint; never a default node.
 *   - LlmError (any other non-2xx / transport failure), including LlmTimeoutError (a 504
 *     UPSTREAM_TIMEOUT or the client's own abort): a failed decision. The derivation engine counts
 *     the chunk as FAILED (never silently skips it), which is what blocks the tree from `derived`.
 *
 * `LlmMalformedError` (truncated JSON / finish_reason === 'length') is defined for the M5
 * classifier; M3 derivation drops malformed rows per-chunk via `parseChunkNodes`.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatOptions {
  providerId: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmChatResult {
  content: string;
  finish_reason: string | null;
}

/**
 * Calls the internal LLM proxy and returns the assistant text plus finish_reason when present.
 * Throws LlmThrottledError on 429, LlmTimeoutError past the deadline and LlmError on every other
 * failure. Never returns a partial/empty success on error.
 */
export async function llmChat(opts: LlmChatOptions): Promise<LlmChatResult> {
  const r = await callInternalLlm({
    apiBaseUrl: env.BBB_API_INTERNAL_URL ?? 'http://api:4000',
    secret: env.INTERNAL_SERVICE_SECRET,
    service: 'bursar',
    providerId: opts.providerId,
    messages: opts.messages,
    maxTokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0,
    timeoutMs: opts.timeoutMs ?? env.BURSAR_LLM_TIMEOUT_MS,
  });
  return { content: r.content, finish_reason: r.finish_reason };
}
