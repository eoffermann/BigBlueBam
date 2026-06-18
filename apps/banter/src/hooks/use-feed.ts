import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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

/**
 * Effective follow state for a channel (resolves default + explicit rows).
 * `enabled` lets a caller defer the fetch (e.g. a per-feed-card menu that should
 * only look up state when the menu is actually opened, not once per card).
 */
export function useChannelFollow(channelId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['channel-follow', channelId],
    queryFn: () =>
      api.get<{ data: ChannelFollow }>(`/channels/${channelId}/follow`).then((r) => r.data),
    enabled: !!channelId && enabled,
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
      qc.invalidateQueries({ queryKey: ['feed'] });
    },
  });
}

// ---------------------------------------------------------------------------
// The ranked feed
// ---------------------------------------------------------------------------

export interface FeedEntry {
  id: string;
  category: string;
  source: string;
  entity_type: string;
  entity_id: string;
  /** For thread entries, the thread-root message id; null when the entity IS the root. */
  root_entity_id: string | null;
  channel_id: string | null;
  channel_slug: string | null;
  project_id: string | null;
  published_at: string;
  last_activity_at: string;
  engagement_count: number;
  seen: boolean;
  score: number;
  title: string;
  preview: string | null;
  author: { id: string; display_name: string; avatar_url: string | null } | null;
  deep_link: string;
  open_in_app: string | null;
  score_breakdown?: Record<string, number>;
}

interface FeedPage {
  data: FeedEntry[];
  next_cursor: string | null;
}

export interface FeedFilters {
  category?: string;
  source?: string;
  unseen?: boolean;
}

/** The caller's ranked feed, paged. Polls every 60s as a freshness fallback. */
export function useFeed(filters: FeedFilters = {}) {
  return useInfiniteQuery({
    queryKey: ['feed', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params: Record<string, string | number | boolean | undefined> = {
        limit: 30,
        cursor: pageParam ?? undefined,
        category: filters.category,
        source: filters.source,
        unseen: filters.unseen ? true : undefined,
      };
      return api.get<FeedPage>('/feed', params);
    },
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: 60_000,
  });
}

/** A single hydrated entry, for the /feed/:id permalink view. */
export function useFeedEntry(entryId: string | undefined) {
  return useQuery({
    queryKey: ['feed-entry', entryId],
    queryFn: () =>
      api.get<{ data: FeedEntry }>(`/feed/${entryId}?explain=true`).then((r) => r.data),
    enabled: !!entryId,
  });
}

/** Mark entries seen (by id list or seq watermark). */
export function useMarkFeedSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { entry_ids?: string[]; before_seq?: number }) =>
      api.post<{ data: { marked: number } }>('/feed/seen', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feed'] }),
  });
}

/** Dismiss a single entry (excluded from future reads). */
export function useDismissFeedEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      api.post<{ data: { success: boolean } }>(`/feed/${entryId}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feed'] }),
  });
}
