import { z } from 'zod';
import { LLM_CALL_TIMEOUT_DEFAULT_MS, LLM_CALL_TIMEOUT_MAX_MS, LLM_CALL_TIMEOUT_MIN_MS } from '../llm-deadline.js';

// The request and response contract of the Bam api's POST /internal/llm/chat proxy (#283). The
// proxy parses requests with this schema and every caller builds its body through the shared
// client (@bigbluebam/shared/internal-llm-client), so a field added here (timeout_ms in #257)
// reaches every caller at once instead of one.

export const internalLlmMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type InternalLlmMessage = z.infer<typeof internalLlmMessageSchema>;

export const internalLlmChatRequestSchema = z.object({
  provider_id: z.string().uuid(),
  messages: z.array(internalLlmMessageSchema).min(1),
  model: z.string().max(200).optional(),
  max_tokens: z.number().int().positive().max(100000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  // The upstream deadline for this call (#257): LLM_CALL_TIMEOUT_MIN_MS to LLM_CALL_TIMEOUT_MAX_MS;
  // absent means LLM_CALL_TIMEOUT_DEFAULT_MS.
  timeout_ms: z.number().int().min(LLM_CALL_TIMEOUT_MIN_MS).max(LLM_CALL_TIMEOUT_MAX_MS).optional(),
});
export type InternalLlmChatRequest = z.infer<typeof internalLlmChatRequestSchema>;

/**
 * The proxy's 503 code for a call it stopped because the api is shutting down (#294). The caller
 * retries after Retry-After (another api instance answers), like a 429.
 */
export const LLM_PROXY_SHUTTING_DOWN_CODE = 'SHUTTING_DOWN';

/** The proxy's success body: `{ data: InternalLlmChatResponse }`. */
export interface InternalLlmChatResponse {
  content: string;
  /** 'length' when the answer was cut off at max_tokens (both provider families). */
  finish_reason: string | null;
  usage: unknown;
}

/**
 * A service's LLM deadline env var (#283): an integer number of milliseconds inside the proxy's
 * own bounds, so a value the proxy would refuse or silently cut is refused at boot instead.
 * Defaults to the proxy's own default unless the service's spec names another value.
 */
export function llmTimeoutEnvSchema(defaultMs: number = LLM_CALL_TIMEOUT_DEFAULT_MS) {
  return z.coerce.number().int().min(LLM_CALL_TIMEOUT_MIN_MS).max(LLM_CALL_TIMEOUT_MAX_MS).default(defaultMs);
}
