import { getTenantSnapshot } from '@/stores/tenant.store';
import { impersonateHeader } from '@bigbluebam/ui/impersonation-banner';

// HB-52: Echo the csrf_token cookie in X-CSRF-Token header on state-
// changing requests. The cookie is httpOnly=false so JS can read it.
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>[],
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl = '/helpdesk/api') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (MUTATING_METHODS.has(method)) {
      const csrfToken = readCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }

    // D-010: inject tenant slugs on every request so the helpdesk-api
    // can scope queries to the active org (and optional project) rather
    // than the historical `LIMIT 1` fallback.
    const tenant = getTenantSnapshot();
    if (tenant.orgSlug) headers['X-Org-Slug'] = tenant.orgSlug;
    if (tenant.projectSlug) headers['X-Project-Slug'] = tenant.projectSlug;

    Object.assign(headers, impersonateHeader());

    const response = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorData: {
        error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string };
      } = {};
      try {
        errorData = await response.json();
      } catch {
        // ignore parse errors
      }
      throw new ApiError(
        response.status,
        errorData.error?.code ?? 'UNKNOWN',
        errorData.error?.message ?? `Request failed with status ${response.status}`,
        errorData.error?.details,
        errorData.error?.request_id,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const json = await response.json();
    return json as T;
  }

  get<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);

    const uploadHeaders: Record<string, string> = {};
    const csrfToken = readCsrfToken();
    if (csrfToken) uploadHeaders['X-CSRF-Token'] = csrfToken;
    // D-010: tenant headers on multipart uploads too.
    const tenant = getTenantSnapshot();
    if (tenant.orgSlug) uploadHeaders['X-Org-Slug'] = tenant.orgSlug;
    if (tenant.projectSlug) uploadHeaders['X-Project-Slug'] = tenant.projectSlug;

    Object.assign(uploadHeaders, impersonateHeader());

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: uploadHeaders,
      credentials: 'include',
      body: formData,
    });

    if (response.status === 401) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
    }

    if (!response.ok) {
      let errorData: {
        error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string };
      } = {};
      try {
        errorData = await response.json();
      } catch {
        // ignore
      }
      throw new ApiError(
        response.status,
        errorData.error?.code ?? 'UNKNOWN',
        errorData.error?.message ?? `Upload failed with status ${response.status}`,
        errorData.error?.details,
        errorData.error?.request_id,
      );
    }

    const json = await response.json();
    return json as T;
  }
}

export const api = new ApiClient();
