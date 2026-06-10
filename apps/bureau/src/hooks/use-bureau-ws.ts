/**
 * useBureauWs(floorId) — opens a dedicated BureauWsClient, subscribes to a
 * floor, and pipes presence_snapshot / presence_delta / room_enter /
 * room_leave / status_changed events into the bureau-store.
 *
 * Note: the SDK's mountBureauClient() also owns a BureauWsClient for the
 * docked box. This hook intentionally creates its OWN client so the floor
 * SPA can subscribe to a floor without dragging the user's docked-box
 * presence into it. That's fine: the WS hub is multi-connection-aware.
 *
 * If we later want to share a single socket, the SDK exposes `client` on
 * the mountBureauClient() return value — we'd switch to that and drop the
 * second WebSocket. v1 prioritizes simplicity.
 */

import { useEffect, useRef, useState } from 'react';
import {
  BureauWsClient,
  type BureauConnectionStatus,
} from '@bigbluebam/bureau-client';
import { useBureauStore } from '@/stores/bureau-store';

export interface UseBureauWs {
  status: BureauConnectionStatus;
  /** Imperative: ask the server to enter a room. */
  enterRoom: (roomId: string) => void;
  /** Imperative: leave the current room. */
  leaveRoom: () => void;
  /** Imperative: knock on a closed-door room. */
  knock: (roomId: string, message?: string) => void;
}

export function useBureauWs(floorId: string | null | undefined): UseBureauWs {
  const [status, setStatus] = useState<BureauConnectionStatus>('idle');
  const clientRef = useRef<BureauWsClient | null>(null);
  const hydrateFromSnapshot = useBureauStore((s) => s.hydrateFromSnapshot);
  const applyEnter = useBureauStore((s) => s.applyEnter);
  const applyLeave = useBureauStore((s) => s.applyLeave);
  const applyStatus = useBureauStore((s) => s.applyStatus);

  useEffect(() => {
    if (!floorId) return;
    const client = new BureauWsClient();
    clientRef.current = client;

    const unsubs: Array<() => void> = [];

    unsubs.push(client.onStatus(setStatus));

    unsubs.push(
      client.on('connected', () => {
        // Subscribe to the floor right after auth handshake.
        client.send({ type: 'subscribe_floor', floorId });
      }),
    );

    unsubs.push(
      client.on('presence_snapshot', (msg) => {
        if (msg.floorId !== floorId) return;
        hydrateFromSnapshot(msg.occupancy);
      }),
    );

    unsubs.push(
      client.on('room_enter', (msg) => {
        applyEnter(msg.roomId, msg.userId);
      }),
    );

    unsubs.push(
      client.on('room_leave', (msg) => {
        applyLeave(msg.roomId, msg.userId);
      }),
    );

    unsubs.push(
      client.on('presence_delta', (msg) => {
        // presence_delta carries roomId optionally. When set, treat it as
        // an enter (the server already handles the prior-room removal).
        if (msg.roomId) {
          applyEnter(msg.roomId, msg.userId);
        } else if (msg.roomId === null) {
          // Explicit leave — we don't know the prior room id from the
          // payload, so we just drop the user from userToRoom; the next
          // enter will resolve it.
          const prior = useBureauStore.getState().userToRoom[msg.userId];
          if (prior) applyLeave(prior, msg.userId);
        }
        if (msg.status) {
          applyStatus(msg.userId, msg.status);
        }
      }),
    );

    unsubs.push(
      client.on('status_changed', (msg) => {
        applyStatus(msg.userId, msg.status);
      }),
    );

    void client.connect().catch(() => {
      /* WS auto-reconnects; onStatus surfaces the failure */
    });

    return () => {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
      clientRef.current = null;
    };
  }, [floorId, hydrateFromSnapshot, applyEnter, applyLeave, applyStatus]);

  return {
    status,
    enterRoom: (roomId: string) => {
      clientRef.current?.send({ type: 'enter_room', roomId });
    },
    leaveRoom: () => {
      clientRef.current?.send({ type: 'leave_room' });
    },
    knock: (roomId: string, message?: string) => {
      clientRef.current?.send({ type: 'knock', roomId, message });
    },
  };
}
