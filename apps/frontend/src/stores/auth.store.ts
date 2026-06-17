import { create } from 'zustand';
import type { User } from '@bigbluebam/shared';
import { api, ApiError } from '@/lib/api';

interface AuthError {
  message: string;
  cause?: string;
  requestId?: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: AuthError | null;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { email: string; password: string; display_name: string; org_name: string }) => Promise<void>;
  bootstrap: (data: { email: string; password: string; display_name: string; org_name: string }) => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  clearError: () => void;
  /** Shallow-merge fields into the in-store user (keeps the SPA in sync after a
   *  PATCH /auth/me without a full refetch). No-op when signed out. */
  patchUser: (patch: Partial<User>) => void;
  /** Mark the first-time-user experience as completed (account-level) by
   *  setting `notification_prefs.ftue_completed` and persisting via PATCH
   *  /auth/me. Falls back to a local mark if the request fails so the user is
   *  never trapped in the tour for the rest of the session. */
  completeFtue: () => Promise<void>;
}

function toAuthError(err: unknown, fallback: string): AuthError {
  if (err instanceof ApiError) {
    const detailCause = err.details && err.details.length > 0
      ? (err.details[0] as any)?.message ?? JSON.stringify(err.details[0])
      : undefined;
    return {
      message: err.message,
      cause: detailCause,
      requestId: err.requestId,
    };
  }
  return { message: fallback };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<{ data: { user: User } }>('/auth/login', { email, password });
      set({ user: res.data.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: toAuthError(err, 'Login failed') });
      throw err;
    }
  },

  register: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<{ data: { user: User } }>('/auth/register', data);
      set({ user: res.data.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: toAuthError(err, 'Registration failed') });
      throw err;
    }
  },

  bootstrap: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<{ data: { user: User } }>('/auth/bootstrap', data);
      set({ user: res.data.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: toAuthError(err, 'Bootstrap failed') });
      throw err;
    }
  },

  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore logout errors
    }
    set({ user: null, isAuthenticated: false });
  },

  fetchMe: async () => {
    try {
      const res = await api.getQuiet<{ data: User }>('/auth/me');
      set({ user: res.data, isAuthenticated: true, isLoading: false });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),

  patchUser: (patch) =>
    set((s) => (s.user ? { user: { ...s.user, ...patch } } : s)),

  completeFtue: async () => {
    const current = get().user;
    if (!current) return;
    const prefs = { ...(current.notification_prefs ?? {}), ftue_completed: true };
    try {
      const res = await api.patch<{ data: { notification_prefs?: Record<string, unknown> } }>(
        '/auth/me',
        { notification_prefs: prefs },
      );
      set((s) =>
        s.user
          ? { user: { ...s.user, notification_prefs: res.data.notification_prefs ?? prefs } }
          : s,
      );
    } catch {
      // Persist failed — mark locally so the tour doesn't re-trap this session.
      set((s) => (s.user ? { user: { ...s.user, notification_prefs: prefs } } : s));
    }
  },
}));
