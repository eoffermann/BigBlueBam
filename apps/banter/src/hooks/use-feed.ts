import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Banter Feed hooks (banter-feed-design-document.md).
 *
 * Phase 2: the per-channel follow/mute control. The ranked-feed read hook is
 * added in Phase 4.
 */

export type FeedSubscriptionState = 'following' | 'unfollowed' | 'muted';

interface ChannelFollow {
  channel_id: string;
  state: FeedSubscriptionState;
}

/** Effective follow state for a channel (resolves default + explicit rows). */
export function useChannelFollow(channelId: string | undefined) {
  return useQuery({
    queryKey: ['channel-follow', channelId],
    queryFn: () =>
      api.get<{ data: ChannelFollow }>(`/channels/${channelId}/follow`).then((r) => r.data),
    enabled: !!channelId,
    staleTime: 60_000,
  });
}

/** Set a channel's follow state (following / unfollowed / muted). */
export function useSetChannelFollow(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (state: FeedSubscriptionState) =>
      api.put<{ data: ChannelFollow }>(`/channels/${channelId}/follow`, { state }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channel-follow', channelId] });
      qc.invalidateQueries({ queryKey: ['feed-subscriptions'] });
    },
  });
}
