// Minimal typed client for the Basis REST API. Shares the Bam session cookie.
const BASE = '/basis/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText);
  }
  return json.data as T;
}

export interface Metric {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  unit: string;
  favorable_direction: string;
  certification: string;
  resolve_status: string;
  updated_at: string;
}

export interface MetricVersion {
  id: string;
  version_number: number;
  definition: unknown;
  change_note: string | null;
  created_at: string;
}

export const api = {
  listMetrics: (certification?: string) =>
    req<Metric[]>('GET', `/metrics${certification ? `?filter[certification]=${certification}` : ''}`),
  getMetric: (id: string) =>
    req<{ metric: Metric; currentVersion: MetricVersion | null }>('GET', `/metrics/${id}`),
  createMetric: (input: unknown) =>
    req<{ metric: Metric; currentVersion: MetricVersion }>('POST', '/metrics', input),
  listVersions: (id: string) => req<MetricVersion[]>('GET', `/metrics/${id}/versions`),
  certify: (id: string) => req<Metric>('POST', `/metrics/${id}/certify`),
  decertify: (id: string) => req<Metric>('POST', `/metrics/${id}/decertify`),
  deprecate: (id: string) => req<Metric>('DELETE', `/metrics/${id}`),
  getValue: (id: string, from: string, to: string) =>
    req<{ value: number | null; unit: string }>('GET', `/metrics/${id}/value?from=${from}&to=${to}`),
  explain: (id: string, input: unknown) => req<unknown>('POST', `/metrics/${id}/explain`, input),
  getSettings: () => req<unknown>('GET', '/settings'),
};
