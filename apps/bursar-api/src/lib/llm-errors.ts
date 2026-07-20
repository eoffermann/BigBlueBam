// The typed LLM failure modes, in their own module with NO env/db import so the engine core and
// the unit tests can import them without booting the service env (which process.exits when the
// service env vars are absent). `llm-client.ts` imports and re-exports these.

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

export class LlmMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmMalformedError';
  }
}
