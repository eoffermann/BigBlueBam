import { create } from 'zustand';
import { clientSessionAttempt, loadSession } from '@bigbluebam/ui/session';
import { api, ApiError } from '@/lib/api';

export interface HelpdeskUser {
  id: string;
  email: string;
  display_name: string;
  email_verified: boolean;
}

interface AuthState {
  user: HelpdeskUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { email: string; password: string; display_name: string }) => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<{ data: { user: HelpdeskUser } }>('/auth/login', { email, password });
      set({ user: res.data.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Login failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  register: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post<{ data: { user: HelpdeskUser } }>('/auth/register', data);
      set({ user: res.data.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Registration failed';
      set({ isLoading: false, error: message });
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
    // #412: only a 401 signs the user out. A 429, a 5xx or a dropped connection keeps the
    // session and retries (honouring Retry-After) behind the shared Reconnecting notice.
    const session = await loadSession(
      clientSessionAttempt(() => api.get<{ data: HelpdeskUser }>('/auth/me')),
    );
    if (session.kind === 'signed_out') {
      set({ user: null, isAuthenticated: false, isLoading: false });
      return;
    }
    set({ user: session.data.data, isAuthenticated: true, isLoading: false });
  },

  clearError: () => set({ error: null }),
}));
