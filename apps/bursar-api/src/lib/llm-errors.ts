// The typed LLM failure modes, in their own module with NO env/db import so the engine core and
// the unit tests can import them without booting the service env (which process.exits when the
// service env vars are absent). `llm-client.ts` imports and re-exports these. The transport
// errors are the shared internal LLM client's own classes (#283): LlmTimeoutError (a call that ran
// past BURSAR_LLM_TIMEOUT_MS) is an LlmError, so every existing branch on LlmError still holds.
export { LlmError, LlmThrottledError, LlmTimeoutError } from '@bigbluebam/shared/internal-llm-client';

export class LlmMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmMalformedError';
  }
}
