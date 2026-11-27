import { callInternalLlm } from '@bigbluebam/shared/internal-llm-client';
import { env } from '../env.js';
import type { LlmChat, LlmChatResult, LlmMessage } from './llm-errors.js';

/**
 * The one place bastion-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * through the shared client (@bigbluebam/shared/internal-llm-client, #283).
 * `X-Internal-Service: bastion` keys the proxy's own per-service cap independently of the other
 * satellites; Bastion's leased permits (lib/llm-permits.ts) sit in front of it.
 *
 * The deadline (#257) is BASTION_LLM_TIMEOUT_MS, sent to the proxy as timeout_ms (env.ts refuses
 * a value above LLM_CALL_TIMEOUT_MAX_MS at boot); the shared client waits LLM_CLIENT_GRACE_MS
 * longer so the proxy's own 504 arrives first.
 *
 *   429 -> LlmThrottledError (the caller waits Retry-After inside its slice budget)
 *   504 UPSTREAM_TIMEOUT, or the client's abort -> LlmTimeoutError (counted apart)
 *   any other failure -> LlmError (the compiler falls back to the library for that control)
 */
export const llmChat: LlmChat = async (opts: { providerId: string; messages: LlmMessage[]; maxTokens: number }): Promise<LlmChatResult> => {
  const r = await callInternalLlm({
    apiBaseUrl: env.BBB_API_INTERNAL_URL,
    secret: env.INTERNAL_SERVICE_SECRET,
    service: 'bastion',
    providerId: opts.providerId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    temperature: 0,
    timeoutMs: env.BASTION_LLM_TIMEOUT_MS,
  });
  return { content: r.content, finish_reason: r.finish_reason };
};
