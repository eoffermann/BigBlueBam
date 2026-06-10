import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

// Slug → channel.id registry published on window so main.tsx's
// describeLocation() can resolve the canonical surface id for
// `huddle-banter-{channel_id}` without re-fetching. Updated whenever
// useChannels() resolves. Lives on window because describeLocation is
// invoked outside React (from history wrappers).
declare global {
  interface Window {
    __banterChannelIndex?: Record<string, string>;
  }
}

export interface DmOtherParticipant {
  id: string;
  display_name: string;
  avatar_url: string | null;
  presence: 'online' | 'idle' | 'offline';
}

export interface Channel {
  id: string;
  slug: string;
  name: string;
  type: 'public' | 'private' | 'dm' | 'group_dm';
  topic: string | null;
  description: string | null;
  is_private: boolean;
  is_archived: boolean;
  is_default: boolean;
  member_count: number;
  created_at: string;
  created_by: string;
  last_message_at: string | null;
  /** For type='dm' only — the OTHER participant in the DM (not the
   *  current user). Resolved server-side from channel_memberships so
   *  both sides of the DM see the counterparty's name, not their own. */
  dm_other_participant?: DmOtherParticipant | null;
}

/** The label to display for a channel in the sidebar / header.
 *  For DMs this resolves to the other participant's display name so
 *  both sides see the counterparty's name. Falls back to channel.name
 *  (e.g. for group DMs or if the server hasn't enriched the response). */
export function channelDisplayName(channel: Channel): string {
  if (channel.type === 'dm' && channel.dm_other_participant) {
    return channel.dm_other_participant.display_name;
  }
  return channel.name;
}

export interface ChannelMember {
  id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  presence: string;
  role: 'owner' | 'admin' | 'member';
}

/** Fetch all channels the user is a member of */
export function useChannels() {
  // Key the cache by active org so a tab whose user has switched orgs
  // (via Bam's org switcher) refetches instead of surfacing stale data
  // from the previous org. Without this, TanStack Query reuses the old
  // ['channels'] entry regardless of which org the backend now resolves.
  const activeOrgId = useAuthStore((s) => s.user?.active_org_id);
  const query = useQuery({
    queryKey: ['channels', activeOrgId],
    queryFn: () => api.get<{ data: Channel[] }>('/channels').then((r) => r.data),
    enabled: !!activeOrgId,
  });

  // Publish slug→id map so describeLocation() in main.tsx can resolve
  // /channels/:slug to the canonical channel.id for the Bureau huddle
  // room name. DM routes already use the channel id in the URL, so they
  // don't need the registry.
  useEffect(() => {
    if (!query.data) return;
    const index: Record<string, string> = {};
    for (const ch of query.data) {
      if (ch.slug) index[ch.slug] = ch.id;
    }
    window.__banterChannelIndex = index;
    // Notify any non-React listener (the bureau-client SDK pull is
    // driven by route changes; firing popstate after a fresh fetch
    // makes the SDK re-read describeLocation() with the new map).
    window.dispatchEvent(new Event('banter:channels-updated'));
  }, [query.data]);

  return query;
}

/** Fetch a single channel by slug or ID */
export function useChannel(slugOrId: string) {
  return useQuery({
    queryKey: ['channels', slugOrId],
    queryFn: () => api.get<{ data: Channel }>(`/channels/${slugOrId}`).then((r) => r.data),
    enabled: !!slugOrId,
  });
}

/** Fetch all public/browsable channels */
export function useBrowseChannels(search?: string) {
  return useQuery({
    queryKey: ['channels', 'browse', search],
    queryFn: () =>
      api
        .get<{ data: Channel[] }>('/channels/browse', { search: search || undefined })
        .then((r) => r.data),
  });
}

/** Fetch channel members */
export function useChannelMembers(channelId: string) {
  return useQuery({
    queryKey: ['channels', channelId, 'members'],
    queryFn: () =>
      api.get<{ data: ChannelMember[] }>(`/channels/${channelId}/members`).then((r) => r.data),
    enabled: !!channelId,
  });
}

/** Create a new channel */
export function useCreateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; topic?: string; description?: string; is_private?: boolean }) =>
      api.post<{ data: Channel }>('/channels', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/** Join a channel */
export function useJoinChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      api.post<{ data: Channel }>(`/channels/${channelId}/join`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/** Leave a channel */
export function useLeaveChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.post(`/channels/${channelId}/leave`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/** Update a channel's settings */
export function useUpdateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, ...data }: { channelId: string; name?: string; topic?: string; description?: string; allow_bots?: boolean; allow_huddles?: boolean }) =>
      api.patch<{ data: Channel }>(`/channels/${channelId}`, data).then((r) => r.data),
    onSuccess: (channel) => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['channels', channel.slug] });
    },
  });
}

/** Update a channel member's role */
export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, userId, role }: { channelId: string; userId: string; role: 'admin' | 'member' }) =>
      api.patch(`/channels/${channelId}/members/${userId}`, { role }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['channels', vars.channelId, 'members'] });
    },
  });
}
