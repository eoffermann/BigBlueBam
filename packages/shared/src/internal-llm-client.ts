// The one client for the Bam api's internal LLM proxy, POST /internal/llm/chat (#283).
//
// Every service that asks the platform's configured LLM a question goes through here: bastion,
// bursar, burn, bulwark, bolt ai-assist, the worker's basis-explain job and the mcp-server Blast
// tools. Before #283 each of them hand-built the request body, picked its own deadline and folded
// the proxy's 504 into a generic failure, so a deadline raised in one place was still cut at 60 s
// by the proxy (#257) everywhere else.
//
// What this client guarantees, for every caller:
//   - the body is built from the shared request schema (schemas/internal-llm.ts);
//   - the caller's deadline is SENT as timeout_ms, clamped exactly as the proxy clamps it
//     (llmCallDeadlineMs), so the proxy applies the same deadline upstream;
//   - the client waits LLM_CLIENT_GRACE_MS past that deadline, so the proxy's own 504 answer
//     arrives before this side gives up;
//   - 429 is an LlmThrottledError (wait Retry-After), 504 UPSTREAM_TIMEOUT or the client's own
//     abort is an LlmTimeoutError (counted apart: the knob is the deadline), anything else an
//     LlmError.
//
// SERVER-ONLY: it carries INTERNAL_SERVICE_SECRET. Shipped as its own tsup entry and package
// subpath, never re-exported from src/index.ts, like visibility-client.ts.

import { LLM_CLIENT_GRACE_MS, LLM_UPSTREAM_TIMEOUT_CODE, llmCallDeadlineMs } from './llm-deadline.js';
import {
  LLM_PROXY_SHUTTING_DOWN_CODE,
  type InternalLlmChatRequest,
  type InternalLlmChatResponse,
  type InternalLlmMessage,
} from './schemas/internal-llm.js';

export type { InternalLlmChatRequest, InternalLlmChatResponse, InternalLlmMessage };

/** The proxy refused for now (429, its per-service concurrency or rate cap): wait, then retry. */
export class LlmThrottledError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('internal LLM proxy returned 429 (concurrency cap)');
    this.name = 'LlmThrottledError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Any other failure: a non-2xx answer, a transport error, or an answer with no content. */
export class LlmError extends Error {
  status: number | null;
  /** The proxy's error code when it sent one (e.g. UPSTREAM_ERROR, NOT_FOUND). */
  code: string | null;
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The call ran past its deadline: the proxy's 504 UPSTREAM_TIMEOUT, or this client's own abort.
 * Still an LlmError (callers fall back the same way), but counted apart, because the knob is the
 * caller's deadline setting, not a broken provider.
 */
export class LlmTimeoutError extends LlmError {
  timeoutMs: number;
  constructor(timeoutMs: number, status: number | null) {
    super(`the AI call took longer than ${Math.round(timeoutMs / 1000)} s`, status, LLM_UPSTREAM_TIMEOUT_CODE);
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface InternalLlmCallOptions {
  /** The Bam api's internal base URL (e.g. http://api:4000). */
  apiBaseUrl: string;
  /** INTERNAL_SERVICE_SECRET. Empty means the call cannot be made (LlmError, no request sent). */
  secret: string | null | undefined;
  /** Keys the proxy's per-service concurrency and rate caps (X-Internal-Service). */
  service: string;
  providerId: string;
  messages: InternalLlmMessage[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
  /** The caller's deadline. Clamped like the proxy clamps it; absent means the proxy default. */
  timeoutMs?: number | null;
  /** Extra request headers (bolt ai-assist forwards the session cookie). */
  headers?: Record<string, string>;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** The deadline a call with this setting gets at the proxy, and so the one this client sends. */
export function internalLlmDeadlineMs(timeoutMs?: number | null): number {
  return llmCallDeadlineMs(timeoutMs);
}

/** How long this client waits for one call before aborting it on its own side. */
export function internalLlmClientWaitMs(timeoutMs?: number | null): number {
  return llmCallDeadlineMs(timeoutMs) + LLM_CLIENT_GRACE_MS;
}

/**
 * One chat completion through the internal proxy. Resolves with the answer; throws
 * LlmThrottledError, LlmTimeoutError or LlmError. Never resolves with a partial answer on error.
 */
export async function callInternalLlm(opts: InternalLlmCallOptions): Promise<InternalLlmChatResponse> {
  if (!opts.secret) throw new LlmError('INTERNAL_SERVICE_SECRET is empty; cannot call the internal LLM proxy', null);
  const deadlineMs = internalLlmDeadlineMs(opts.timeoutMs);
  // Typed by the shared contract; the proxy parses it with internalLlmChatRequestSchema.
  const body: InternalLlmChatRequest = {
    provider_id: opts.providerId,
    messages: opts.messages,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    timeout_ms: deadlineMs,
  };
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs + LLM_CLIENT_GRACE_MS);
  try {
    const res = await doFetch(`${opts.apiBaseUrl.replace(/\/+$/, '')}/internal/llm/chat`, {
      method: 'POST',
      headers: {
        ...(opts.headers ?? {}),
        'Content-Type': 'application/json',
        'X-Internal-Secret': opts.secret,
        'X-Internal-Service': opts.service,
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? '2');
      throw new LlmThrottledError(Number.isFinite(ra) && ra > 0 ? ra : 2);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = typeof err?.error?.code === 'string' ? err.error.code : null;
      // An api instance going down stopped the call (#294): retry like a 429, another answers.
      if (res.status === 503 && code === LLM_PROXY_SHUTTING_DOWN_CODE) {
        const ra = Number(res.headers.get('retry-after') ?? '5');
        throw new LlmThrottledError(Number.isFinite(ra) && ra > 0 ? ra : 5);
      }
      if (res.status === 504 || code === LLM_UPSTREAM_TIMEOUT_CODE) throw new LlmTimeoutError(deadlineMs, res.status);
      throw new LlmError(`internal LLM proxy returned ${res.status}`, res.status, code);
    }
    const answer = (await res.json().catch(() => null)) as { data?: Partial<InternalLlmChatResponse> } | null;
    const content = answer?.data?.content;
    if (typeof content !== 'string') throw new LlmError('internal LLM proxy returned no content', res.status);
    return { content, finish_reason: answer?.data?.finish_reason ?? null, usage: answer?.data?.usage ?? null };
  } catch (err) {
    if (err instanceof LlmError || err instanceof LlmThrottledError) throw err;
    if (controller.signal.aborted) throw new LlmTimeoutError(deadlineMs, null);
    throw new LlmError(err instanceof Error ? err.message : 'LLM transport failure', null);
  } finally {
    clearTimeout(timer);
  }
}
