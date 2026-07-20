import { Wifi, WifiOff, Loader2 } from 'lucide-react';
import type { RealtimeStatus } from '@/hooks/use-bursar-realtime';
import { cn } from '@/lib/utils';

// The visible connection state for /bursar/ws (spec 11.1). When the socket is not open the UI
// still updates: GET /requests/:id/leveling-runs polled at 5s is the authoritative fallback, so
// "reconnecting" here is informational, not a broken state.
export function RealtimeIndicator({ status }: { status: RealtimeStatus }) {
  if (status === 'open') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400" title="Live updates connected">
        <Wifi className="h-3.5 w-3.5" /> Live
      </span>
    );
  }
  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400')}
        title="Reconnecting to live updates. Progress still refreshes every 5 seconds."
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reconnecting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400" title="Live updates offline. Progress refreshes every 5 seconds.">
      <WifiOff className="h-3.5 w-3.5" /> Offline
    </span>
  );
}
