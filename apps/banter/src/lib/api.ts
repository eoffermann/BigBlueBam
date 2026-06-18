import { useAuthStore } from '@/stores/auth.store';
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

  constructor(baseUrl = '/banter/api/v1') {
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

    const headers: Record<string, string> = {};

    // Only set Content-Type for requests that have a body
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    // Defense-in-depth X-Org-Id injection. The Banter API also reads
    // sessions.active_org_id off the session cookie, but forwarding the
    // header here keeps a long-lived tab pinned to the org it was opened
    // in even if a different tab has since switched orgs. Safe: the
    // server validates that the caller is actually a member of the
    // requested org before honoring the header.
    const activeOrgId = useAuthStore.getState().user?.active_org_id;
    if (activeOrgId) {
      headers['X-Org-Id'] = activeOrgId;
    }

    // SuperUser impersonation: echo X-Impersonate-User when an "act as" session
    // is active so the API swaps to the target here too. Inert otherwise.
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

    const uploadHeaders: Record<string, string> = {};
    const activeOrgId = useAuthStore.getState().user?.active_org_id;
    if (activeOrgId) {
      uploadHeaders['X-Org-Id'] = activeOrgId;
    }
    Object.assign(uploadHeaders, impersonateHeader());

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: uploadHeaders,
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
