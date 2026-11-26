import { LLM_CLIENT_GRACE_MS, LLM_UPSTREAM_TIMEOUT_CODE } from '@bigbluebam/shared';
import { env } from '../env.js';
import { LlmError, LlmThrottledError, LlmTimeoutError, type LlmChat, type LlmChatResult, type LlmMessage } from './llm-errors.js';

/**
 * The one place bastion-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * which holds the encrypted provider keys (ported from apps/bursar-api/src/lib/llm-client.ts).
 * `X-Internal-Service: bastion` keys the proxy's own per-service cap independently of the other
 * satellites; Bastion's leased permits (lib/llm-permits.ts) sit in front of it.
 *
 * The deadline (#257) is BASTION_LLM_TIMEOUT_MS, SENT to the proxy as timeout_ms so the proxy
 * applies the same one upstream (capped by LLM_CALL_TIMEOUT_MAX_MS, which env.ts enforces at
 * boot); this client waits LLM_CLIENT_GRACE_MS longer so the proxy's own 504 arrives first.
 *
 *   429 -> LlmThrottledError (the caller waits Retry-After inside its slice budget)
 *   504 UPSTREAM_TIMEOUT, or this client's abort -> LlmTimeoutError (counted apart)
 *   any other failure -> LlmError (the compiler falls back to the library for that control)
 */
export const llmChat: LlmChat = async (opts: { providerId: string; messages: LlmMessage[]; maxTokens?: number }): Promise<LlmChatResult> => {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new LlmError('INTERNAL_SERVICE_SECRET is empty; cannot call the internal LLM proxy', null);
  const timeoutMs = env.BASTION_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + LLM_CLIENT_GRACE_MS);
  try {
    const res = await fetch(`${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/llm/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
        'X-Internal-Service': 'bastion',
      },
      signal: controller.signal,
      body: JSON.stringify({
        provider_id: opts.providerId,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: 0,
        timeout_ms: timeoutMs,
      }),
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? '2');
      throw new LlmThrottledError(Number.isFinite(ra) && ra > 0 ? ra : 2);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (res.status === 504 || err?.error?.code === LLM_UPSTREAM_TIMEOUT_CODE) throw new LlmTimeoutError(timeoutMs, res.status);
      throw new LlmError(`internal LLM proxy returned ${res.status}`, res.status);
    }
    const body = (await res.json().catch(() => null)) as { data?: { content?: string; finish_reason?: string } } | null;
    const content = body?.data?.content;
    if (typeof content !== 'string') throw new LlmError('internal LLM proxy returned no content', res.status);
    return { content, finish_reason: body?.data?.finish_reason ?? null };
  } catch (err) {
    if (err instanceof LlmThrottledError || err instanceof LlmError) throw err;
    if (controller.signal.aborted) throw new LlmTimeoutError(timeoutMs, null);
    throw new LlmError(err instanceof Error ? err.message : 'LLM transport failure', null);
  } finally {
    clearTimeout(timer);
  }
};
