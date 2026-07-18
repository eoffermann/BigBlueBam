// Minimal typed client for the Basis REST API. Shares the Bam session cookie.
//
// Response/request shapes are imported from @bigbluebam/shared (the single source
// of truth per spec section 4) as `import type` so no zod runtime is pulled into
// the SPA bundle. Do NOT re-declare metric/version shapes here.
import type {
  BasisMetric,
  BasisMetricVersion,
  BasisMetricWithVersion,
  BasisValue,
  BasisExplanation,
  BasisOrgSettings,
  CreateBasisMetricInput,
  BasisExplainRequest,
} from '@bigbluebam/shared';

const BASE = '/basis/api/v1';

// Re-export the shared metric shapes under the SPA's historical names so existing
// component imports keep working without re-typing the API contract.
export type Metric = BasisMetric;
export type MetricVersion = BasisMetricVersion;

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

// Bench's governed data-source catalog (its widget wizard reads the same one).
// Basis lets a human pick a source + real fields from this instead of typing raw
// strings. Fetched cross-app over the shared session.
export interface DsMeasure {
  field: string;
  label: string;
  aggregations: string[];
  type: string;
}
export interface DsDimension {
  field: string;
  label: string;
  type: string;
}
export interface DsFilter {
  field: string;
  label: string;
  operators: string[];
  type: string;
  enumValues?: string[];
}
export interface DataSource {
  product: string;
  entity: string;
  label: string;
  description?: string;
  measures: DsMeasure[];
  dimensions: DsDimension[];
  filters: DsFilter[];
}

export async function getDataSources(): Promise<DataSource[]> {
  const res = await fetch('/bench/api/v1/data-sources', { credentials: 'include' });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return (json.data ?? json ?? []) as DataSource[];
}

export const api = {
  listMetrics: (certification?: string) =>
    req<BasisMetric[]>('GET', `/metrics${certification ? `?filter[certification]=${certification}` : ''}`),
  getMetric: (id: string) => req<BasisMetricWithVersion>('GET', `/metrics/${id}`),
  createMetric: (input: CreateBasisMetricInput) =>
    req<BasisMetricWithVersion>('POST', '/metrics', input),
  listVersions: (id: string) => req<BasisMetricVersion[]>('GET', `/metrics/${id}/versions`),
  certify: (id: string) => req<BasisMetric>('POST', `/metrics/${id}/certify`),
  decertify: (id: string) => req<BasisMetric>('POST', `/metrics/${id}/decertify`),
  deprecate: (id: string) => req<BasisMetric>('DELETE', `/metrics/${id}`),
  getValue: (id: string, from: string, to: string) =>
    req<BasisValue>('GET', `/metrics/${id}/value?from=${from}&to=${to}`),
  explain: (id: string, input: BasisExplainRequest) =>
    req<BasisExplanation>('POST', `/metrics/${id}/explain`, input),
  getSettings: () => req<BasisOrgSettings>('GET', '/settings'),
};
