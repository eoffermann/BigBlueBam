import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

export function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;

/** A fetch mock routed by "METHOD /path". Unrouted calls answer 404. */
export function routedFetch(routes: Record<string, Handler>) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const k = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`;
    const h = routes[k];
    return h ? h(init, url) : jsonResponse(404, { error: { code: 'NOT_FOUND', message: `no mock for ${k}` } });
  });
}

export const EMPTY_STEPS = {
  frameworks: { done: true },
  profile: { done: true, answered: 10, total: 10 },
  compliance_project: { done: false },
  compile: { done: true },
  review: { done: false, waiting: 0, populations_waiting: 0 },
  applicability: { done: true, frameworks: [] },
};

export function setupState(over: Record<string, unknown> = {}) {
  return {
    data: {
      frameworks: [],
      company_profile: {},
      compliance_project: null,
      proposed_checks: [],
      steps: EMPTY_STEPS,
      complete: false,
      ...over,
    },
  };
}
