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

  constructor(baseUrl = '/beacon/api/v1') {
    this.baseUrl = baseUrl;
  }

  /**
   * Resolve the active org_id so the beacon-api knows which org context to use.
   * We lazily import the auth store to avoid circular dependencies at module init.
   */
  private getOrgId(): string | undefined {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = (globalThis as any).__beaconAuthStore;
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

    // Send active org context so beacon-api resolves the correct org
    const orgId = this.getOrgId();
    if (orgId) {
      headers['X-Org-Id'] = orgId;
    }

    // Only set Content-Type for requests that have a body
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    // SuperUser impersonation: echo X-Impersonate-User when active. Inert otherwise.
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

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    const headers: Record<string, string> = {};
    const orgId = this.getOrgId();
    if (orgId) headers['X-Org-Id'] = orgId;
    Object.assign(headers, impersonateHeader());

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: formData,
      // No Content-Type header — browser sets it with boundary for multipart
    });

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
