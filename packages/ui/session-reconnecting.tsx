import { useSyncExternalStore } from 'react';
import { isSessionReconnecting, subscribeSessionReconnecting } from './session';

/** React view of the shared Reconnecting state (#412). */
export function useSessionReconnecting(): boolean {
  return useSyncExternalStore(subscribeSessionReconnecting, isSessionReconnecting, () => false);
}

/**
 * The small "Reconnecting" pill shown while the session check is retrying after a rate limit,
 * a server error, or a dropped connection. The user stays signed in meanwhile. Mounted once per
 * SPA next to <App />. Inline styles so it renders the same in every SPA's Tailwind build.
 */
export function SessionReconnectingNotice() {
  const reconnecting = useSessionReconnecting();
  if (!reconnecting) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-reconnecting"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        padding: '6px 14px',
        borderRadius: 9999,
        background: 'rgba(24, 24, 27, 0.9)',
        color: '#fafafa',
        fontSize: 13,
        lineHeight: '20px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        pointerEvents: 'none',
      }}
    >
      Reconnecting...
    </div>
  );
}
