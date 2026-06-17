import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ws } from '@/lib/websocket';
import { useChannelStore } from '@/stores/channel.store';

/**
 * Resolve the channel id from an event body, tolerating the different shapes
 * the banter-api emits: top-level `channel_id` (typing/unread/read), nested
 * under `message` (message.*), or under `call` (call.started). Returns
 * undefined when the body carries no channel id — callers treat that as "this
 * room's event" since events only arrive for rooms we're subscribed to.
 */
function eventChannelId(payload: unknown): string | undefined {
  const p = payload as
    | { channel_id?: string; message?: { channel_id?: string }; call?: { channel_id?: string } }
    | null
    | undefined;
  return p?.channel_id ?? p?.message?.channel_id ?? p?.call?.channel_id;
}

/**
 * Subscribe to a channel room via WebSocket and invalidate
 * relevant queries when events arrive.
 */
export function useRealtimeChannel(channelId: string) {
  const queryClient = useQueryClient();
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const setUnreadCount = useChannelStore((s) => s.setUnreadCount);

  useEffect(() => {
    if (!channelId) return;

    // The WS server namespaces channel rooms as `banter:channel:<id>` and only
    // honors subscribes with that prefix (ws/handler.ts). The old `channel:<id>`
    // never matched, so the client was never actually in the room and received
    // no message events — which is why the timeline only refreshed on refocus.
    const room = `banter:channel:${channelId}`;
    ws.joinRoom(room);

    // Events only reach us for rooms we're subscribed to, so an event whose
    // body resolves to this channel (or carries no channel id) is ours.
    const isForThisChannel = (event: { payload: unknown }) => {
      const cid = eventChannelId(event.payload);
      return cid === undefined || cid === channelId;
    };

    const unsubMessage = ws.on('message.created', (event) => {
      if (!isForThisChannel(event)) return;
      queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
      // If this is not the active channel, refresh unread counts too.
      if (activeChannelId !== channelId) {
        queryClient.invalidateQueries({ queryKey: ['unread-counts'] });
      }
    });

    const unsubEdit = ws.on('message.updated', (event) => {
      if (isForThisChannel(event)) {
        queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
      }
    });

    const unsubDelete = ws.on('message.deleted', (event) => {
      if (isForThisChannel(event)) {
        queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
      }
    });

    const unsubReaction = ws.on('reaction.toggled', (event) => {
      if (isForThisChannel(event)) {
        queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
      }
    });

    const unsubUnread = ws.on('unread.updated', (event) => {
      const payload = event.payload as {
        unread_messages?: number;
        unread_mentions?: number;
      } | null;
      if (isForThisChannel(event) && payload && typeof payload.unread_messages === 'number') {
        setUnreadCount(channelId, payload.unread_messages, payload.unread_mentions ?? 0);
      }
    });

    // Call events — invalidate messages to show system call event messages
    const unsubCallStarted = ws.on('call.started', (event) => {
      const payload = event.payload as { call?: { channel_id: string } };
      if (payload.call?.channel_id === channelId) {
        queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
      }
    });

    const unsubCallEnded = ws.on('call.ended', () => {
      // Refresh messages to show "call ended" system message
      queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
    });

    const unsubCallJoin = ws.on('call.participant_joined', () => {
      queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
    });

    const unsubCallLeave = ws.on('call.participant_left', () => {
      queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
    });

    return () => {
      ws.leaveRoom(room);
      unsubMessage();
      unsubEdit();
      unsubDelete();
      unsubReaction();
      unsubUnread();
      unsubCallStarted();
      unsubCallEnded();
      unsubCallJoin();
      unsubCallLeave();
    };
  }, [channelId, activeChannelId, queryClient, setUnreadCount]);
}

/**
 * Subscribe to the user's global presence/notification room.
 */
export function useRealtimeGlobal() {
  const queryClient = useQueryClient();
  const setUnreadCount = useChannelStore((s) => s.setUnreadCount);

  useEffect(() => {
    ws.joinRoom('global');

    const unsubChannels = ws.on('channel.updated', () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    });

    const unsubCreated = ws.on('channel.created', () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    });

    // Cross-device read cursor sync: when this user marks a channel as
    // read on another device/tab, update unread counts here immediately.
    const unsubReadSync = ws.on('channel.read_cursor_synced', (event) => {
      const payload = event.payload as {
        channel_id: string;
        message_id: string;
      };
      if (payload.channel_id) {
        // Reset unread count for the synced channel and refresh from server
        setUnreadCount(payload.channel_id, 0, 0);
        queryClient.invalidateQueries({ queryKey: ['unread-counts'] });
        queryClient.invalidateQueries({ queryKey: ['channels'] });
      }
    });

    return () => {
      ws.leaveRoom('global');
      unsubChannels();
      unsubCreated();
      unsubReadSync();
    };
  }, [queryClient, setUnreadCount]);
}
