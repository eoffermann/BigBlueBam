import { create } from 'zustand';

interface ChannelState {
  /** Currently active channel ID */
  activeChannelId: string | null;
  setActiveChannel: (id: string | null) => void;

  /** Sidebar collapsed state */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  /** Draft messages keyed by channel ID */
  draftMessages: Record<string, string>;
  setDraft: (channelId: string, content: string) => void;
  clearDraft: (channelId: string) => void;

  /** Unread counts keyed by channel ID */
  unreadCounts: Record<string, { messages: number; mentions: number }>;
  setUnreadCount: (channelId: string, messages: number, mentions: number) => void;
  clearUnread: (channelId: string) => void;

  /** Thread panel state */
  activeThreadMessageId: string | null;
  openThread: (messageId: string) => void;
  closeThread: () => void;
}

// Live audio/video call state moved to the shared Bureau docked-box in
// Phase 2 of the unified-LiveKit migration. The per-channel huddle is
// implicit: whichever channel the user is viewing, the docked box joins
// `huddle-banter-{channel_id}`. There is no Banter-side activeCall state.
export const useChannelStore = create<ChannelState>((set) => ({
  activeChannelId: null,
  setActiveChannel: (id) => set({ activeChannelId: id }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  draftMessages: {},
  setDraft: (channelId, content) =>
    set((s) => ({ draftMessages: { ...s.draftMessages, [channelId]: content } })),
  clearDraft: (channelId) =>
    set((s) => {
      const { [channelId]: _, ...rest } = s.draftMessages;
      return { draftMessages: rest };
    }),

  unreadCounts: {},
  setUnreadCount: (channelId, messages, mentions) =>
    set((s) => ({
      unreadCounts: { ...s.unreadCounts, [channelId]: { messages, mentions } },
    })),
  clearUnread: (channelId) =>
    set((s) => {
      const { [channelId]: _, ...rest } = s.unreadCounts;
      return { unreadCounts: rest };
    }),

  activeThreadMessageId: null,
  openThread: (messageId) => set({ activeThreadMessageId: messageId }),
  closeThread: () => set({ activeThreadMessageId: null }),
}));
