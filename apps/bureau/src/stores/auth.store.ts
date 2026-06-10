import { create } from 'zustand';

export interface BureauUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  org_id: string;
  role: string;
  is_superuser?: boolean;
}

interface AuthState {
  user: BureauUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  /** Verify session by calling Bam's auth check endpoint (shared session). */
  fetchMe: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  fetchMe: async () => {
    try {
      const res = await fetch('/b3/api/auth/me', { credentials: 'include' });
      if (!res.ok) throw new Error('Not authenticated');
      const json = await res.json();
      const user = json.data;
      set({
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          avatar_url: user.avatar_url ?? null,
          org_id: user.org_id,
          role: user.role,
          is_superuser: user.is_superuser === true,
        },
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
