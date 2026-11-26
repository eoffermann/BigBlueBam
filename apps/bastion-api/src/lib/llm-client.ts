import { env } from '../env.js';
import { LlmError, LlmThrottledError, type LlmChat, type LlmChatResult, type LlmMessage } from './llm-errors.js';

/**
 * The one place bastion-api calls the Bam api's internal LLM proxy (`POST /internal/llm/chat`),
 * which holds the encrypted provider keys (ported from apps/bursar-api/src/lib/llm-client.ts).
 * `X-Internal-Service: bastion` keys the proxy's own per-service cap independently of the other
 * satellites; Bastion's leased permits (lib/llm-permits.ts) sit in front of it. The timeout is
 * BASTION_LLM_TIMEOUT_MS (60 s), matching the proxy's upstream deadline.
 *
 *   429 -> LlmThrottledError (the caller waits Retry-After inside its slice budget)
 *   any other failure -> LlmError (the compiler falls back to the library for that control)
 */
export const llmChat: LlmChat = async (opts: { providerId: string; messages: LlmMessage[]; maxTokens: number }): Promise<LlmChatResult> => {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new LlmError('INTERNAL_SERVICE_SECRET is empty; cannot call the internal LLM proxy', null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.BASTION_LLM_TIMEOUT_MS);
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
        max_tokens: opts.maxTokens,
        temperature: 0,
      }),
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? '2');
      throw new LlmThrottledError(Number.isFinite(ra) && ra > 0 ? ra : 2);
    }
    if (!res.ok) throw new LlmError(`internal LLM proxy returned ${res.status}`, res.status);
    const body = (await res.json().catch(() => null)) as { data?: { content?: string; finish_reason?: string } } | null;
    const content = body?.data?.content;
    if (typeof content !== 'string') throw new LlmError('internal LLM proxy returned no content', res.status);
    return { content, finish_reason: body?.data?.finish_reason ?? null };
  } catch (err) {
    if (err instanceof LlmThrottledError || err instanceof LlmError) throw err;
    throw new LlmError(err instanceof Error ? err.message : 'LLM transport failure', null);
  } finally {
    clearTimeout(timer);
  }
};
