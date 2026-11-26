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

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatResult {
  content: string;
  finish_reason: string | null;
}

/**
 * One chat call through the platform's internal LLM proxy (injected so tests can record or fake it).
 * maxTokens is required: every caller passes its kind's budget from library/llm-call-settings.ts,
 * so a new caller cannot silently fall back to some other number (#263, #264).
 */
export type LlmChat = (opts: { providerId: string; messages: LlmMessage[]; maxTokens: number }) => Promise<LlmChatResult>;
