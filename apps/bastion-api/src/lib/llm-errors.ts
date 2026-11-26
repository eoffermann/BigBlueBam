// The typed LLM failure modes (copied from apps/bursar-api/src/lib/llm-errors.ts), in their own
// module with NO env import so the compiler core and the unit tests can import them without
// booting the service env.

export class LlmThrottledError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('internal LLM proxy returned 429 (concurrency cap)');
    this.name = 'LlmThrottledError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class LlmError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/**
 * The call ran past its deadline (#257): the proxy's 504 UPSTREAM_TIMEOUT, or the client's own
 * abort. Still an LlmError (every caller falls back the same way), but counted apart, because the
 * knob is BASTION_LLM_TIMEOUT_MS (or a smaller BASTION_LLM_MAX_TOKENS), not a broken provider.
 */
export class LlmTimeoutError extends LlmError {
  timeoutMs: number;
  constructor(timeoutMs: number, status: number | null) {
    super(`the AI call took longer than ${Math.round(timeoutMs / 1000)} s`, status);
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

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
