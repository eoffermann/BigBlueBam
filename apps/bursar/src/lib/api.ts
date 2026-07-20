// Thin fetch helpers for the Bursar SPA. Bursar shares Bam's session cookie; the API is proxied
// at /bursar/api/. All calls send credentials.

const BASE = '/bursar/api/v1';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } })?.error?.message ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return json as T;
}

export interface ScopeNode {
  id: string;
  title: string;
  description: string | null;
  node_kind: string;
  normative_strength: string;
  derived_from: string | null;
  review_status: string;
  contributing_offer_ids: string[];
  cited_span: { quote?: string | null; cited_line?: number | null; verified?: boolean } | null;
  confidence: string | null;
}

export interface ScopeRequest {
  id: string;
  title: string;
  scope_status: string;
  injection_suspected: boolean;
  injection_signals: { categories?: string[]; spans?: Array<{ category: string; match: string }> } | null;
}

export interface ScopeRun {
  id: string;
  status: string;
  chunks_failed: number;
  nodes_extracted: number;
  error: string | null;
}

export interface ScopeResponse {
  data: { request: ScopeRequest; nodes: ScopeNode[]; latest_run: ScopeRun | null };
}

export const scopeApi = {
  get: (requestId: string) => req<ScopeResponse>('GET', `/requests/${requestId}/scope`),
  derive: (requestId: string, source_text?: string) =>
    req<{ data: { run_id: string; scope_status: string } }>('POST', `/requests/${requestId}/derive-scope`, {
      ...(source_text ? { source_text } : {}),
    }),
  applyLibrary: (requestId: string, library_ids: string[]) =>
    req<{ data: { applied: number; requested: number } }>('POST', `/requests/${requestId}/scope/apply-library`, {
      library_ids,
    }),
  confirm: (requestId: string, clear_injection?: boolean) =>
    req<{ data: ScopeRequest }>('POST', `/requests/${requestId}/scope/confirm`, {
      ...(clear_injection ? { clear_injection } : {}),
    }),
  promoteRival: (nodeId: string) =>
    req<{ data: ScopeNode; contributing_offer_ids: string[] }>('POST', `/scope-nodes/${nodeId}/promote-rival`, {}),
};
