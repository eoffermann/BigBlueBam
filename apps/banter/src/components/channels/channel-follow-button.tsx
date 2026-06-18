import { useEffect, useRef, useState } from 'react';
import { Bell, BellMinus, BellOff, Check, ChevronDown } from 'lucide-react';
import {
  useChannelFollow,
  useSetChannelFollow,
  type FeedSubscriptionState,
} from '@/hooks/use-feed';
import { cn } from '@/lib/utils';

/**
 * Per-channel follow/mute control (banter-feed-design-document.md §5, §17.2).
 *
 * - following  → channel activity surfaces in your Feed (the default).
 * - unfollowed → soft opt-out: stop general activity, still notify on direct
 *    mentions/relationships.
 * - muted      → hard opt-out: nothing from this channel, ever.
 */

const OPTIONS: {
  state: FeedSubscriptionState;
  label: string;
  hint: string;
  icon: typeof Bell;
}[] = [
  { state: 'following', label: 'Following', hint: 'Show this channel in my Feed', icon: Bell },
  {
    state: 'unfollowed',
    label: 'Unfollowed',
    hint: 'Hide general activity, still alert me when mentioned',
    icon: BellMinus,
  },
  { state: 'muted', label: 'Muted', hint: 'Nothing from this channel', icon: BellOff },
];

export function ChannelFollowButton({ channelId }: { channelId: string }) {
  const { data, isLoading } = useChannelFollow(channelId);
  const setFollow = useSetChannelFollow(channelId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const state = data?.state ?? 'following';
  const current = OPTIONS.find((o) => o.state === state) ?? OPTIONS[0]!;
  const Icon = current.icon;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={isLoading}
        onClick={() => setOpen((v) => !v)}
        title={`Feed: ${current.label}`}
        aria-label={`Feed subscription: ${current.label}`}
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 rounded-md transition-colors text-sm',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800',
          state === 'following'
            ? 'text-green-600 dark:text-green-400'
            : state === 'muted'
              ? 'text-zinc-400'
              : 'text-zinc-500',
        )}
      >
        <Icon className="h-4 w-4" />
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-60 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg z-20 py-1">
          {OPTIONS.map((opt) => {
            const OptIcon = opt.icon;
            const selected = opt.state === state;
            return (
              <button
                key={opt.state}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (opt.state !== state) setFollow.mutate(opt.state);
                }}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <OptIcon className="h-4 w-4 mt-0.5 flex-shrink-0 text-zinc-500" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {opt.label}
                  </span>
                  <span className="block text-xs text-zinc-500">{opt.hint}</span>
                </span>
                {selected && <Check className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
