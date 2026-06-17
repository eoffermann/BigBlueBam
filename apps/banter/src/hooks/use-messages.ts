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
  /** Whether the CURRENT user has bookmarked this message. Drives the
   *  persistent bookmarked indicator on the row (the list endpoint computes
   *  it per-request). Optional because thread/single-message payloads may
   *  not populate it yet. */
  is_bookmarked?: boolean;
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

/**
 * Descriptor for a file already uploaded via POST /v1/files/upload. The upload
 * endpoint returns { key, url, filename, content_type, size_bytes } — there is
 * no pre-message attachment id. The message-post route turns each descriptor
 * into a banter_message_attachments row keyed to the new message.
 */
export interface NewMessageAttachment {
  key: string;
  url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

/** Post a new message */
export function usePostMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      content,
      attachments,
    }: {
      channelId: string;
      content: string;
      attachments?: NewMessageAttachment[];
    }) =>
      api
        .post<{ data: Message }>(`/channels/${channelId}/messages`, {
          content,
          attachments,
        })
        .then((r) => r.data),
    onSuccess: (msg) => {
      queryClient.invalidateQueries({ queryKey: ['messages', msg.channel_id] });
    },
  });
}

/**
 * Edit an existing message. The banter-api route is `PATCH /v1/messages/:id`
 * (NOT channel-scoped) — `channelId` is carried only so onSuccess can target
 * the right ['messages', channelId] cache key.
 */
export function useEditMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      content,
    }: {
      channelId: string;
      messageId: string;
      content: string;
    }) =>
      api.patch<{ data: Message }>(`/messages/${messageId}`, { content }).then((r) => r.data),
    onSuccess: (msg) => {
      queryClient.invalidateQueries({ queryKey: ['messages', msg.channel_id] });
    },
  });
}

/** Delete a message. Route is `DELETE /v1/messages/:id` (not channel-scoped). */
export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId }: { channelId: string; messageId: string }) =>
      api.delete(`/messages/${messageId}`),
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
 * Unpin a message from its channel. Route: `DELETE /v1/channels/:id/pins/:messageId`.
 * Admin-gated server-side (same as pin). Powers toggle-off from the row.
 */
export function useUnpinMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      api.delete(`/channels/${channelId}/pins/${messageId}`),
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
    mutationFn: ({ messageId, note }: { messageId: string; channelId?: string; note?: string }) =>
      api.post<{ data: { id?: string; already_bookmarked?: boolean } }>(`/bookmarks`, {
        message_id: messageId,
        note,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
      // Refresh the channel so the message's is_bookmarked flips to true.
      if (vars.channelId) {
        queryClient.invalidateQueries({ queryKey: ['messages', vars.channelId] });
      }
    },
  });
}

/**
 * Remove the current user's bookmark for a message, by message id (the row
 * knows its own id, not the bookmark id). Powers toggle-off from a message's
 * Bookmark control. Route: `DELETE /v1/bookmarks/by-message/:messageId`.
 */
export function useRemoveBookmarkByMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId }: { messageId: string; channelId?: string }) =>
      api.delete(`/bookmarks/by-message/${messageId}`),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
      if (vars.channelId) {
        queryClient.invalidateQueries({ queryKey: ['messages', vars.channelId] });
      }
    },
  });
}
