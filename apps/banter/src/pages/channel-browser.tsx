import { useState } from 'react';
import { Search, Hash, Users, Plus, Check } from 'lucide-react';
import { useBrowseChannels, useJoinChannel, useChannels } from '@/hooks/use-channels';
import { formatRelativeTime } from '@/lib/utils';

interface ChannelBrowserProps {
  onNavigate: (path: string) => void;
}

export function ChannelBrowser({ onNavigate }: ChannelBrowserProps) {
  const [search, setSearch] = useState('');
  const { data: channels, isLoading } = useBrowseChannels(search);
  const { data: myChannels } = useChannels();
  const joinChannel = useJoinChannel();

  const myChannelIds = new Set(myChannels?.map((c) => c.id) ?? []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Browse Channels
        </h2>
      </header>

      {/* Search bar */}
      <div className="px-6 py-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search channels..."
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none focus:border-primary-400 dark:focus:border-primary-600 transition-colors"
          />
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 pb-6">
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full" />
          </div>
        )}

        {!isLoading && channels?.length === 0 && (
          <div className="text-center py-12 text-zinc-500">
            <p className="text-lg font-medium">No channels found</p>
            <p className="text-sm mt-1">Try a different search term</p>
          </div>
        )}

        <div className="grid gap-3">
          {channels?.map((channel) => {
            const isMember = myChannelIds.has(channel.id);
            return (
              <div
                key={channel.id}
                className="flex items-start justify-between gap-4 p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 hover:border-primary-300 dark:hover:border-primary-700 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Hash className="h-4 w-4 text-zinc-400 flex-shrink-0" />
                    <button
                      onClick={() => onNavigate(`/channels/${channel.slug}`)}
                      className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
                    >
                      {channel.name}
                    </button>
                    {channel.is_private && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-700 text-zinc-500 font-medium">
                        Private
                      </span>
                    )}
                  </div>
                  {channel.topic && (
                    <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{channel.topic}</p>
                  )}
                  <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {channel.member_count} members
                    </span>
                    {channel.last_message_at && (
                      <span>Last active {formatRelativeTime(channel.last_message_at)}</span>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0">
                  {isMember ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20">
                      <Check className="h-4 w-4" />
                      Joined
                    </span>
                  ) : (
                    <button
                      onClick={() => joinChannel.mutate(channel.id)}
                      disabled={joinChannel.isPending}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 transition-colors disabled:opacity-50"
                    >
                      <Plus className="h-4 w-4" />
                      Join
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
