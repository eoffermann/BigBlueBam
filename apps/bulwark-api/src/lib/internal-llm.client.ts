import { env } from '../env.js';

// Internal llm-provider client (spec 2.5 point 6 / 4.1). Extraction and notice/chase
// drafting go ONLY through the platform's internal llm-provider proxy
// (apps/api/src/routes/internal-llm.routes.ts), never a third-party endpoint and never a
// new LLM_* api-key env var. The proxy holds the encrypted provider keys.
//
// Untrusted contract/clause/event text MUST be fenced as DATA by the caller (S8); the model
// is forbidden to emit control fields and any it emits are dropped by the deterministic
// post-processing (THEME E). Bounded by an AbortController so a slow provider cannot hang a
// worker.

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatResult {
  content: string;
}

// Returns null on any transport/timeout/non-2xx error so callers degrade gracefully (a
// failed extraction chunk is retried; a failed draft defers).
export async function internalLlmChat(args: {
  providerId: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}): Promise<LlmChatResult | null> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return null; // no secret -> cannot call the internal proxy
  const url = `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/llm/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        provider_id: args.providerId,
        messages: args.messages,
        max_tokens: args.maxTokens ?? 4096,
        temperature: args.temperature ?? 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { content?: string } };
    const content = json.data?.content;
    return typeof content === 'string' ? { content } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
