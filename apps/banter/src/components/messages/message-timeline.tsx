import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import { useMessages, type Message } from '@/hooks/use-messages';
import { MessageItem } from './message-item';
import { formatMessageDate } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface MessageTimelineProps {
  channelId: string;
  onNavigate: (path: string) => void;
}

export function MessageTimeline({ channelId, onNavigate }: MessageTimelineProps) {
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages(channelId);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // The API returns messages newest-first (created_at DESC) for cursor
  // pagination. Flatten every loaded page and sort chronologically so the
  // timeline renders oldest at the top and newest at the bottom — standard chat
  // order. (The previous code reversed page order but not within-page order, so
  // a single page rendered fully backwards and a new reply jumped to the top.)
  // Sorting (rather than a bare reverse) is robust to the API's ordering.
  const allMessages: Message[] = (data?.pages ?? [])
    .flatMap((p) => p.data)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [allMessages.length, autoScroll]);

  // Scroll detection
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    setShowJumpToBottom(distanceFromBottom > 200);
    setAutoScroll(distanceFromBottom < 50);

    // Load more when scrolled near top
    if (scrollTop < 100 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setAutoScroll(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto custom-scrollbar px-4 py-2"
      >
        {/* Load more indicator */}
        {isFetchingNextPage && (
          <div className="flex justify-center py-4">
            <div className="animate-spin h-5 w-5 border-2 border-primary-500 border-t-transparent rounded-full" />
          </div>
        )}

        {hasNextPage && !isFetchingNextPage && (
          <div className="flex justify-center py-2">
            <button
              onClick={() => fetchNextPage()}
              className="text-sm text-primary-500 hover:text-primary-400 transition-colors"
            >
              Load older messages
            </button>
          </div>
        )}

        {/* Messages */}
        {allMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-2">
            <p className="text-lg font-medium">No messages yet</p>
            <p className="text-sm">Be the first to send a message!</p>
          </div>
        )}

        {allMessages.map((message, index) => {
          const prevMessage = index > 0 ? allMessages[index - 1] : null;
          const showDateSeparator =
            !prevMessage ||
            formatMessageDate(message.created_at) !==
              formatMessageDate(prevMessage.created_at);

          // Group messages: same author within 5 minutes
          const isGrouped =
            prevMessage &&
            !showDateSeparator &&
            prevMessage.author_id === message.author_id &&
            !prevMessage.is_system &&
            !message.is_system &&
            new Date(message.created_at).getTime() -
              new Date(prevMessage.created_at).getTime() <
              5 * 60 * 1000;

          return (
            <div key={message.id}>
              {showDateSeparator && (
                <DateSeparator date={formatMessageDate(message.created_at)} />
              )}
              <MessageItem
                message={message}
                channelId={channelId}
                grouped={!!isGrouped}
                onNavigate={onNavigate}
              />
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom */}
      {showJumpToBottom && (
        <button
          onClick={scrollToBottom}
          className={cn(
            'absolute bottom-4 right-4 flex items-center gap-1 px-3 py-1.5 rounded-full',
            'bg-primary-600 text-white text-sm font-medium shadow-lg',
            'hover:bg-primary-700 transition-colors',
          )}
        >
          <ArrowDown className="h-4 w-4" />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-700" />
      <span className="text-xs font-medium text-zinc-500 bg-white dark:bg-zinc-900 px-2">
        {date}
      </span>
      <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-700" />
    </div>
  );
}
