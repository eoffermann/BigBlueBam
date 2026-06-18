import { impersonateHeader } from '@bigbluebam/ui/impersonation-banner';

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

  constructor(baseUrl = '/book/api') {
    this.baseUrl = baseUrl;
  }

  private getOrgId(): string | undefined {
    try {
      const mod = (globalThis as any).__bookAuthStore;
      return mod?.getState?.()?.user?.org_id;
    } catch {
      return undefined;
    }
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

    const headers: Record<string, string> = {};

    const orgId = this.getOrgId();
    if (orgId) {
      headers['X-Org-Id'] = orgId;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

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

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

export const api = new ApiClient();
