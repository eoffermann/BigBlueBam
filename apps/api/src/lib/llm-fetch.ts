import { safeFetch } from '@bigbluebam/egress-guard';

/**
 * Every server-side call to an LLM provider's api_endpoint goes through here.
 * api_endpoint is set by an org admin, so the call is SSRF-guarded by
 * @bigbluebam/egress-guard: DNS-resolved private-address refusal, the dialed
 * address pinned to the vetted one, and each redirect hop revalidated. The
 * provider credential headers are dropped if a redirect leaves the origin.
 * A self-hosted model on the stack's own network must be listed in
 * EGRESS_ALLOW_PRIVATE_HOSTS (#328).
 */
export function llmFetch(url: string, init: RequestInit): Promise<Response> {
  return safeFetch(url, init, { stripHeadersOnCrossOrigin: ['x-api-key', 'authorization'] });
}
