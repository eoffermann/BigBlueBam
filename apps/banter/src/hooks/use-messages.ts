import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type MessageEditPermission = 'own' | 'thread_starter' | 'none';

export interface Message {
  id: string;
  channel_id: string;
  author_id: string;
  author_display_name: string;
  author_avatar_url: string | null;
  content: string;
  is_edited: boolean;
  is_system: boolean;
  is_bot: boolean;
  is_pinned: boolean;
  /** Who may edit this message. 'own' (default) = author only;
   *  'thread_starter' = the root author of the thread this message belongs to;
   *  'none' = locked, nobody may edit. Seeded on a handful of demo rows. */
  edit_permission?: MessageEditPermission;
  thread_reply_count: number;
  thread_latest_reply_at: string | null;
  reactions: Reaction[];
  attachments: Attachment[];
  has_link_preview?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  users: string[];
  me: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  url: string;
  thumbnail_url?: string;
}

interface MessagesPage {
  data: Message[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Fetch paginated messages for a channel */
export function useMessages(channelId: string) {
  return useInfiniteQuery({
    queryKey: ['messages', channelId],
    queryFn: ({ pageParam }) =>
      api
        .get<MessagesPage>(`/channels/${channelId}/messages`, {
          cursor: pageParam || undefined,
          limit: 50,
        }),
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: !!channelId,
    // Messages load newest first; "next" page loads older messages
  });
}

/** Post a new message */
export function usePostMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      content,
      attachmentIds,
    }: {
      channelId: string;
      content: string;
      attachmentIds?: string[];
    }) =>
      api
        .post<{ data: Message }>(`/channels/${channelId}/messages`, {
          content,
          attachment_ids: attachmentIds,
        })
        .then((r) => r.data),
    onSuccess: (msg) => {
      queryClient.invalidateQueries({ queryKey: ['messages', msg.channel_id] });
    },
  });
}

/** Edit an existing message */
export function useEditMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      messageId,
      content,
    }: {
      channelId: string;
      messageId: string;
      content: string;
    }) =>
      api
        .patch<{ data: Message }>(`/channels/${channelId}/messages/${messageId}`, { content })
        .then((r) => r.data),
    onSuccess: (msg) => {
      queryClient.invalidateQueries({ queryKey: ['messages', msg.channel_id] });
    },
  });
}

/** Delete a message */
export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      api.delete(`/channels/${channelId}/messages/${messageId}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.channelId] });
    },
  });
}

/**
 * Pin a message to its channel. The POST is idempotent server-side: pinning an
 * already-pinned message returns `{ data: { already_pinned: true } }` with no
 * error, so callers can fire-and-forget without checking current pin state.
 */
export function usePinMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      api.post<{ data: { id?: string; already_pinned?: boolean } }>(
        `/channels/${channelId}/pins`,
        { message_id: messageId },
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.channelId] });
      queryClient.invalidateQueries({ queryKey: ['pins', variables.channelId] });
    },
  });
}

/**
 * Bookmark a message for the current user. The POST is idempotent server-side:
 * bookmarking an already-bookmarked message returns
 * `{ data: { already_bookmarked: true } }`. The request body is `{ message_id }`
 * with an optional `note` (see banter-api createBookmarkSchema).
 */
export function useBookmark() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, note }: { messageId: string; note?: string }) =>
      api.post<{ data: { id?: string; already_bookmarked?: boolean } }>(`/bookmarks`, {
        message_id: messageId,
        note,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });
}
