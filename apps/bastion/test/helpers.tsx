import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { expect, vi } from 'vitest';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';

/** Every Bastion action the M3 pages gate on (an owner's matrix). */
export const ALL_BASTION_PERMISSIONS: Record<string, boolean> = {
  'bastion.framework.read': true,
  'bastion.framework.write': true,
  'bastion.framework.compile': true,
  'bastion.control.read': true,
  'bastion.control.write': true,
  'bastion.assertion.propose': true,
  'bastion.assertion.confirm': true,
  'bastion.evidence.read': true,
  'bastion.evidence.upload': true,
  'bastion.evidence.link': true,
  'bastion.evidence.review': true,
  'bastion.evidence.withdraw': true,
  'bastion.feed.read': true,
  'bastion.feed.manage': true,
};

/** A member's matrix for the M5 pages: no floored actions (review, withdraw, feed.manage). */
export const MEMBER_PERMISSIONS: Record<string, boolean> = {
  'bastion.framework.read': true,
  'bastion.control.read': true,
  'bastion.evidence.read': true,
  'bastion.evidence.upload': true,
  'bastion.evidence.link': true,
  'bastion.feed.read': true,
};

/** A viewer's matrix (spec 5.5): reads only. */
export const VIEWER_PERMISSIONS: Record<string, boolean> = {
  'bastion.framework.read': true,
  'bastion.control.read': true,
};

/** Render inside the providers main.tsx mounts, with the given permission matrix. */
export function wrap(ui: ReactNode, permissions: Record<string, boolean> = ALL_BASTION_PERMISSIONS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const fetcher = async () => ({ data: { permissions } });
  const view = render(
    <QueryClientProvider client={qc}>
      <PermissionsProvider fetcher={fetcher}>{ui}</PermissionsProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { qc });
}

/**
 * Wait (inside act, via Testing Library) until no query is fetching and no mutation is running,
 * so a mutation's invalidation refetches settle before the test ends (#224).
 */
export async function settled(qc: QueryClient) {
  await waitFor(() => expect(qc.isFetching() + qc.isMutating()).toBe(0));
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
