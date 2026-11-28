import { create } from 'zustand';
import { fetchSessionAttempt, loadSession } from '@bigbluebam/ui/session';

export interface BanterUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  org_id: string;
  /** The org the user has currently switched to. Persisted server-side
   *  in sessions.active_org_id and returned by /b3/api/auth/me. Used as
   *  the X-Org-Id header on every Banter API request so a tab that has
   *  survived an org switch stays pinned to the correct org. */
  active_org_id: string;
  presence: 'online' | 'idle' | 'dnd' | 'offline';
  role: string;
  is_superuser?: boolean;
}

interface AuthState {
  user: BanterUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  /** Verify session by calling Banter's auth check endpoint. */
  fetchMe: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  fetchMe: async () => {
    // Use the Bam auth endpoint since Banter shares the same session
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
        // `/b3/api/auth/me` returns both fields — they are typically equal
        // once resolveOrgContext has run, but we key off active_org_id for
        // the X-Org-Id header and React Query cache to keep them in sync
        // with Bam's switch-org flow.
        active_org_id: user.active_org_id ?? user.org_id,
        presence: 'online',
        role: user.role,
        is_superuser: user.is_superuser === true,
      },
      isAuthenticated: true,
      isLoading: false,
    });
  },
}));
