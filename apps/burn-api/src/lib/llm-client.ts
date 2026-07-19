import { env } from '../env.js';

/**
 * The one place burn-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * which holds the encrypted provider keys (spec 4.0: "burn-api is the process holding the LLM
 * calls"). Every Burn LLM round trip - extraction chunk adjudication and stage-two attribution -
 * goes through here.
 *
 * Two typed failure modes the engines branch on (spec 9.7.1):
 *   - LlmThrottledError (HTTP 429 from the internal concurrency cap): the caller must DEFER,
 *     never invent a scope finding. `burn-attribute-batch` sends the item to
 *     `pending_attribution`; extraction retries the chunk from its checkpoint.
 *   - LlmError (any other non-2xx / transport / timeout): extraction/attribution treat it as a
 *     failed decision (pending_review), never a silent success.
 *
 * The `x-internal-service: burn` header is what keys the api's per-service token bucket, so
 * Burn's LLM load is throttled independently of every other satellite (spec 9.7.1).
 */

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

export interface LlmChatOptions {
  providerId: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

function apiBase(): string {
  return (env.BBB_API_INTERNAL_URL ?? 'http://api:4000').replace(/\/+$/, '');
}

/**
 * Calls the internal LLM proxy and returns the assistant text. Throws LlmThrottledError on 429
 * and LlmError on every other failure. Never returns a partial/empty success on error.
 */
export async function llmChat(opts: LlmChatOptions): Promise<string> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new LlmError('INTERNAL_SERVICE_SECRET is empty; cannot call internal LLM', null);

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? env.LLM_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/internal/llm/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
        // Keys the api's per-service concurrency bucket (spec 9.7.1).
        'X-Internal-Service': 'burn',
      },
      signal: controller.signal,
      body: JSON.stringify({
        provider_id: opts.providerId,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 1024,
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
    const body = (await res.json().catch(() => null)) as { data?: { content?: string } } | null;
    const content = body?.data?.content;
    if (typeof content !== 'string') throw new LlmError('internal LLM proxy returned no content', res.status);
    return content;
  } catch (err) {
    if (err instanceof LlmThrottledError || err instanceof LlmError) throw err;
    // AbortError / network -> non-throttle failure.
    throw new LlmError(err instanceof Error ? err.message : 'LLM transport failure', null);
  } finally {
    clearTimeout(timer);
  }
}
