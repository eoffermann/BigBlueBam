// The typed LLM failure modes, in their own module with NO env import so the compiler core and
// the unit tests can import them without booting the service env. They are the shared client's
// own classes (#283), so what lib/llm-client.ts throws is what the compiler catches. The knob for
// an LlmTimeoutError is BASTION_LLM_TIMEOUT_MS (or a smaller BASTION_LLM_MAX_TOKENS).
export { LlmError, LlmThrottledError, LlmTimeoutError } from '@bigbluebam/shared/internal-llm-client';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatResult {
  content: string;
  finish_reason: string | null;
}

/** One chat call through the platform's internal LLM proxy (injected so tests can record or fake it). */
export type LlmChat = (opts: { providerId: string; messages: LlmMessage[]; maxTokens?: number }) => Promise<LlmChatResult>;
