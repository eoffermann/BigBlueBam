import { callInternalLlm, LlmError, LlmThrottledError, LlmTimeoutError } from '@bigbluebam/shared/internal-llm-client';
import { env } from '../env.js';

/**
 * The one place burn-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * which holds the encrypted provider keys (spec 4.0: "burn-api is the process holding the LLM
 * calls"). Every Burn LLM round trip - extraction chunk adjudication and stage-two attribution -
 * goes through here, and here goes through the shared client
 * (@bigbluebam/shared/internal-llm-client, #283), which builds the body from the shared contract
 * and sends LLM_TIMEOUT_MS to the proxy as timeout_ms, so the proxy applies the same deadline.
 *
 * Typed failure modes the engines branch on (spec 9.7.1):
 *   - LlmThrottledError (HTTP 429 from the internal concurrency cap): the caller must DEFER,
 *     never invent a scope finding. `burn-attribute-batch` sends the item to
 *     `pending_attribution`; extraction retries the chunk from its checkpoint.
 *   - LlmError (any other non-2xx / transport failure), including LlmTimeoutError (504
 *     UPSTREAM_TIMEOUT or the client's own abort, counted apart in the logs): extraction and
 *     attribution treat it as a failed decision (pending_review), never a silent success.
 *
 * The `x-internal-service: burn` header is what keys the api's per-service token bucket, so
 * Burn's LLM load is throttled independently of every other satellite (spec 9.7.1).
 */

export { LlmError, LlmThrottledError, LlmTimeoutError };

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

/**
 * Calls the internal LLM proxy and returns the assistant text. Throws LlmThrottledError on 429,
 * LlmTimeoutError past the deadline and LlmError on every other failure. Never returns a
 * partial/empty success on error.
 */
export async function llmChat(opts: LlmChatOptions): Promise<string> {
  const r = await callInternalLlm({
    apiBaseUrl: env.BBB_API_INTERNAL_URL ?? 'http://api:4000',
    secret: env.INTERNAL_SERVICE_SECRET,
    // Keys the api's per-service concurrency bucket (spec 9.7.1).
    service: 'burn',
    providerId: opts.providerId,
    messages: opts.messages,
    maxTokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0,
    timeoutMs: opts.timeoutMs ?? env.LLM_TIMEOUT_MS,
  });
  return r.content;
}
