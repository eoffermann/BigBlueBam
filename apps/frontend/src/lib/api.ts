import { getImpersonation } from './impersonation';

// HB-52: Read the csrf_token cookie set by the API on login/register and
// echo it back in the X-CSRF-Token header on state-changing requests.
// The cookie is httpOnly=false precisely so this function can read it.
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

  constructor(baseUrl = '/b3/api') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean | undefined | null>,
    _options?: { skipAuthRedirect?: boolean },
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
    // Only set Content-Type when we actually have a body to send.
    // Fastify rejects requests that declare application/json but send no
    // body with "Body cannot be empty when content-type is set to
    // 'application/json'" — hits any body-less POST (e.g. transfer-
    // ownership, context/clear).
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (MUTATING_METHODS.has(method)) {
      const csrfToken = readCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }

    // SuperUser impersonation: when an "act as" session is active, echo the
    // target user id so the API swaps request.user to the target. Absent for
    // normal sessions, so this is inert unless impersonating.
    const impersonation = getImpersonation();
    if (impersonation) headers['X-Impersonate-User'] = impersonation.user_id;

    const response = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

  getQuiet<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    return this.request<T>('GET', path, undefined, params, { skipAuthRedirect: true });
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

  delete<T = void>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);

    const uploadHeaders: Record<string, string> = {};
    const csrfToken = readCsrfToken();
    if (csrfToken) uploadHeaders['X-CSRF-Token'] = csrfToken;

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: uploadHeaders,
      credentials: 'include',
      body: formData,
      // No Content-Type header — browser sets it with boundary for multipart
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
