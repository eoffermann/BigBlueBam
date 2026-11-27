import { LLM_CALL_TIMEOUT_MAX_MS } from '@bigbluebam/shared';
import { callInternalLlm, LlmThrottledError, LlmTimeoutError } from '@bigbluebam/shared/internal-llm-client';
import { env } from '../env.js';

// Internal llm-provider client (spec 2.5 point 6 / 4.1). Extraction and notice/chase
// drafting go ONLY through the platform's internal llm-provider proxy
// (apps/api/src/routes/internal-llm.routes.ts), never a third-party endpoint and never a
// new LLM_* api-key env var. The proxy holds the encrypted provider keys.
//
// Untrusted contract/clause/event text MUST be fenced as DATA by the caller (S8); the model
// is forbidden to emit control fields and any it emits are dropped by the deterministic
// post-processing (THEME E).
//
// The transport is the shared client (@bigbluebam/shared/internal-llm-client, #283): the body is
// built from the shared contract and LLM_TIMEOUT_MS is sent to the proxy as timeout_ms, so the
// proxy applies the same deadline (a slow provider cannot hang a worker, and a raised deadline is
// not cut at 60 s by the proxy).

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatResult {
  content: string;
}

/** What the last failed call was, so an operator can tell a deadline from a broken provider. */
export type InternalLlmFailure = 'timeout' | 'throttled' | 'error';

// Returns null on any transport/timeout/non-2xx error so callers degrade gracefully (a
// failed extraction chunk is retried; a failed draft defers). `onFailure` (optional) is told
// which kind of failure it was; a timeout is also written to stderr with the knob to turn.
export async function internalLlmChat(args: {
  providerId: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  onFailure?: (kind: InternalLlmFailure) => void;
}): Promise<LlmChatResult | null> {
  if (!env.INTERNAL_SERVICE_SECRET) return null; // no secret -> cannot call the internal proxy
  try {
    const r = await callInternalLlm({
      apiBaseUrl: env.BBB_API_INTERNAL_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
      service: 'bulwark',
      providerId: args.providerId,
      messages: args.messages,
      maxTokens: args.maxTokens ?? 4096,
      temperature: args.temperature ?? 0,
      timeoutMs: env.LLM_TIMEOUT_MS,
    });
    return { content: r.content };
  } catch (err) {
    const kind: InternalLlmFailure =
      err instanceof LlmTimeoutError ? 'timeout' : err instanceof LlmThrottledError ? 'throttled' : 'error';
    if (kind === 'timeout') {
      console.warn(
        `bulwark-llm: the AI call ran past its ${Math.round(env.LLM_TIMEOUT_MS / 1000)} s deadline; if this repeats, raise LLM_TIMEOUT_MS (at most ${LLM_CALL_TIMEOUT_MAX_MS})`,
      );
    }
    args.onFailure?.(kind);
    return null;
  }
}
