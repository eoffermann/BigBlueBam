import { env } from '../env.js';
import { LlmThrottledError, LlmError, LlmMalformedError } from './llm-errors.js';

// Re-export so existing importers of the client keep the error classes.
export { LlmThrottledError, LlmError, LlmMalformedError };

/**
 * The one place bursar-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * which holds the encrypted provider keys. Ported from burn-api/src/lib/llm-client.ts with two
 * deliberate differences (spec 3.9 / 3.10):
 *
 *   1. `X-Internal-Service: bursar` keys the proxy's per-service concurrency bucket independently.
 *   2. The default timeout is `BURSAR_LLM_TIMEOUT_MS` (60000), MATCHING the proxy's own
 *      hardcoded 60s upstream deadline (`internal-llm.routes.ts:325`). burn's inherited 15000
 *      aborts routinely, and an aborted client does not release the proxy concurrency slot for
 *      90s, so the wrong timeout compounds into a stall.
 *
 * Two typed failure modes the engine branches on:
 *   - LlmThrottledError (HTTP 429 concurrency cap): DEFER. The derivation slice releases its
 *     claim and re-throws so a retry resumes from the checkpoint; never a default node.
 *   - LlmError (any other non-2xx / transport / timeout): a failed decision. The derivation
 *     engine counts the chunk as FAILED (never silently skips it), which is what blocks the
 *     tree from `derived` (fix b).
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
  /** Present once apps/api's additive `{content, finish_reason, usage}` change lands (M5). */
  finish_reason: string | null;
}

function apiBase(): string {
  return (env.BBB_API_INTERNAL_URL ?? 'http://api:4000').replace(/\/+$/, '');
}

/**
 * Calls the internal LLM proxy and returns the assistant text plus finish_reason when present.
 * Throws LlmThrottledError on 429 and LlmError on every other failure. Never returns a
 * partial/empty success on error.
 */
export async function llmChat(opts: LlmChatOptions): Promise<LlmChatResult> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new LlmError('INTERNAL_SERVICE_SECRET is empty; cannot call internal LLM', null);

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? env.BURSAR_LLM_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/internal/llm/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
        'X-Internal-Service': 'bursar',
      },
      signal: controller.signal,
      body: JSON.stringify({
        provider_id: opts.providerId,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0,
      }),
    });

    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? '2');
      throw new LlmThrottledError(Number.isFinite(ra) && ra > 0 ? ra : 2);
    }
    if (!res.ok) {
      throw new LlmError(`internal LLM proxy returned ${res.status}`, res.status);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { content?: string; finish_reason?: string };
    } | null;
    const content = body?.data?.content;
    if (typeof content !== 'string') throw new LlmError('internal LLM proxy returned no content', res.status);
    return { content, finish_reason: body?.data?.finish_reason ?? null };
  } catch (err) {
    if (err instanceof LlmThrottledError || err instanceof LlmError) throw err;
    throw new LlmError(err instanceof Error ? err.message : 'LLM transport failure', null);
  } finally {
    clearTimeout(timer);
  }
}
