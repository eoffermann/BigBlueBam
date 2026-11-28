import { create } from 'zustand';
import { fetchSessionAttempt, loadSession } from '@bigbluebam/ui/session';

export interface BearingUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  org_id: string;
  role: string;
  is_superuser?: boolean;
}

interface AuthState {
  user: BearingUser | null;
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
    // Use the Bam auth endpoint since Bearing shares the same session
    // #412: only a 401 signs the user out. A 429, a 5xx or a dropped connection keeps the
    // session and retries (honouring Retry-After) behind the shared Reconnecting notice.
    const session = await loadSession(fetchSessionAttempt('/b3/api/auth/me'));
    if (session.kind === 'signed_out') {
      set({ user: null, isAuthenticated: false, isLoading: false });
      return;
    }
    const user = session.data.data;
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
  },
}));

// Expose the store on a global so api.ts can read org_id without circular imports.
(globalThis as any).__bearingAuthStore = useAuthStore;
