/**
 * useActiveCall — React hook over the ActiveCallManager singleton.
 *
 * The hook is the single source of truth for the docked box's mic/cam/screen
 * buttons. It subscribes to the manager on mount and re-renders on every
 * snapshot emit. When the manager isn't initialized yet (the SDK hasn't
 * mounted, or the hook is being read inside a test), it returns a safe
 * idle state and no-op setters so callers don't have to null-check.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getActiveCallManager,
  IDLE_TARGET,
  type ActiveCallSnapshot,
  type ActiveCallStatus,
  type ActiveRoomTarget,
} from './active-room.js';

const INITIAL_SNAPSHOT: ActiveCallSnapshot = {
  status: 'idle',
  target: IDLE_TARGET,
  tracks: { micOn: false, camOn: false, screenOn: false },
  errorMessage: null,
};

export interface UseActiveCall {
  status: ActiveCallStatus;
  target: ActiveRoomTarget;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  errorMessage: string | null;
  setMic: (on: boolean) => void;
  setCam: (on: boolean) => void;
  setScreen: (on: boolean) => void;
}

export function useActiveCall(): UseActiveCall {
  const [snapshot, setSnapshot] = useState<ActiveCallSnapshot>(() => {
    const mgr = getActiveCallManager();
    return mgr ? mgr.getSnapshot() : INITIAL_SNAPSHOT;
  });

  useEffect(() => {
    const mgr = getActiveCallManager();
    if (!mgr) return;
    // subscribe() invokes synchronously with the current snapshot.
    const unsubscribe = mgr.subscribe(setSnapshot);
    return unsubscribe;
  }, []);

  const setMic = useCallback((on: boolean) => {
    const mgr = getActiveCallManager();
    if (!mgr) return;
    void mgr.setMicEnabled(on);
  }, []);

  const setCam = useCallback((on: boolean) => {
    const mgr = getActiveCallManager();
    if (!mgr) return;
    void mgr.setCamEnabled(on);
  }, []);

  const setScreen = useCallback((on: boolean) => {
    const mgr = getActiveCallManager();
    if (!mgr) return;
    void mgr.setScreenShareEnabled(on);
  }, []);

  return {
    status: snapshot.status,
    target: snapshot.target,
    micOn: snapshot.tracks.micOn,
    camOn: snapshot.tracks.camOn,
    screenOn: snapshot.tracks.screenOn,
    errorMessage: snapshot.errorMessage,
    setMic,
    setCam,
    setScreen,
  };
}
