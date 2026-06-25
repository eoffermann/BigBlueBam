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

  constructor(baseUrl = '/bin/api') {
    this.baseUrl = baseUrl;
  }

  private getOrgId(): string | undefined {
    try {
      const mod = (globalThis as any).__binAuthStore;
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

  /** Multipart upload (bytes through the service). Lets the browser set the
   *  multipart boundary; forwards org + impersonation headers + session cookie. */
  async upload<T>(path: string, file: File): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    const headers: Record<string, string> = {};
    const orgId = this.getOrgId();
    if (orgId) headers['X-Org-Id'] = orgId;
    Object.assign(headers, impersonateHeader());
    const fd = new FormData();
    fd.append('file', file, file.name);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: fd,
    });
    if (!response.ok) {
      let e: { error?: { code?: string; message?: string } } = {};
      try {
        e = await response.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(response.status, e.error?.code ?? 'UNKNOWN', e.error?.message ?? `Upload failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  /** Absolute, same-origin URL for a raw byte stream (download/preview). The
   *  session cookie rides along automatically, so an <a download> just works. */
  rawUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export const api = new ApiClient();
