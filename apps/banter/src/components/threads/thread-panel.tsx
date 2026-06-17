import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { X, Send } from 'lucide-react';
import { useThreadReplies, usePostThreadReply } from '@/hooks/use-threads';
import { useChannelStore } from '@/stores/channel.store';
import { MessageItem } from '@/components/messages/message-item';
import { cn, formatMessageTime, formatAbsoluteTime, generateAvatarInitials } from '@/lib/utils';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import type { Message } from '@/hooks/use-messages';
import { useQueryClient } from '@tanstack/react-query';

interface ThreadPanelProps {
  messageId: string;
  channelId: string;
  onNavigate: (path: string) => void;
}

export function ThreadPanel({ messageId, channelId, onNavigate }: ThreadPanelProps) {
  const closeThread = useChannelStore((s) => s.closeThread);
  const { data: replies, isLoading } = useThreadReplies(messageId);
  const postReply = usePostThreadReply();
  const queryClient = useQueryClient();

  const [content, setContent] = useState('');
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch the parent message from the messages cache
  const parentMessage = queryClient
    .getQueriesData<{ pages: { data: Message[] }[] }>({
      queryKey: ['messages', channelId],
    })
    .flatMap(([, data]) => data?.pages.flatMap((p) => p.data) ?? [])
    .find((m) => m.id === messageId);

  // Auto-scroll when new replies arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [replies?.length]);

  const handleSubmit = () => {
    const trimmed = content.trim();
    if (!trimmed) return;

    postReply.mutate(
      { messageId, content: trimmed, alsoSendToChannel },
      {
        onSuccess: () => {
          setContent('');
          textareaRef.current?.focus();
        },
      },
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Thread</h3>
        <button
          onClick={closeThread}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-2">
        {/* Parent message */}
        {parentMessage && (
          <div className="pb-3 mb-3 border-b border-zinc-200 dark:border-zinc-700">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-primary-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                {parentMessage.author_avatar_url ? (
                  <img
                    src={parentMessage.author_avatar_url}
                    alt=""
                    className="h-9 w-9 rounded-lg object-cover"
                  />
                ) : (
                  generateAvatarInitials(parentMessage.author_display_name)
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                    {parentMessage.author_display_name}
                  </span>
                  <span
                    className="text-xs text-zinc-400"
                    title={formatAbsoluteTime(parentMessage.created_at)}
                  >
                    {formatMessageTime(parentMessage.created_at)}
                  </span>
                </div>
                <div
                  className="rich-text-content text-sm text-zinc-800 dark:text-zinc-200"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeHtml(markdownToHtml(parentMessage.content)),
                  }}
                />
              </div>
            </div>
            {replies && replies.length > 0 && (
              <p className="text-xs text-zinc-500 mt-2">
                {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
              </p>
            )}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex justify-center py-4">
            <div className="animate-spin h-5 w-5 border-2 border-primary-500 border-t-transparent rounded-full" />
          </div>
        )}

        {/* Thread replies — the API returns these newest-first by default, so
            sort chronologically to show oldest at the top and newest at the
            bottom (matching the channel timeline). */}
        {(replies ?? [])
          .slice()
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          .map((reply) => (
            <MessageItem
              key={reply.id}
              message={reply}
              channelId={channelId}
              grouped={false}
              onNavigate={onNavigate}
            />
          ))}

        <div ref={bottomRef} />
      </div>

      {/* Compose */}
      <div className="flex-shrink-0 border-t border-zinc-200 dark:border-zinc-700 p-3">
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl bg-white dark:bg-zinc-800 focus-within:border-primary-400 dark:focus-within:border-primary-600 transition-colors">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply..."
            rows={2}
            className="w-full resize-none bg-transparent px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none"
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={alsoSendToChannel}
                onChange={(e) => setAlsoSendToChannel(e.target.checked)}
                className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              Also send to channel
            </label>
            <button
              onClick={handleSubmit}
              disabled={!content.trim()}
              className={cn(
                'p-1.5 rounded-lg transition-colors',
                content.trim()
                  ? 'bg-primary-600 text-white hover:bg-primary-700'
                  : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-400 cursor-not-allowed',
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
