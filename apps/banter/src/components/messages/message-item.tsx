import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import {
  SmilePlus,
  MessageSquare,
  Pin,
  Bookmark,
  MoreHorizontal,
  Pencil,
  Trash2,
  Bot,
  Phone,
  PhoneOff,
  PhoneMissed,
  Lock,
  Crown,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useChannelStore } from '@/stores/channel.store';
import { useToggleReaction } from '@/hooks/use-reactions';
import {
  useDeleteMessage,
  useEditMessage,
  usePinMessage,
  useBookmark,
  useRemoveBookmarkByMessage,
  type Message,
  type Reaction,
} from '@/hooks/use-messages';
import { useAuthStore } from '@/stores/auth.store';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import {
  cn,
  formatMessageTime,
  formatAbsoluteTime,
  generateAvatarInitials,
} from '@/lib/utils';
import { UserProfilePopover } from '@/components/common/user-profile-popover';
import { CrossProductEmbeds } from './cross-product-embed';
import { LinkPreviews } from './link-preview';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🚀'];

interface MessageItemProps {
  message: Message;
  channelId: string;
  grouped: boolean;
  onNavigate: (path: string) => void;
}

export function MessageItem({ message, channelId, grouped, onNavigate: _onNavigate }: MessageItemProps) {
  const [hovered, setHovered] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  // Controlled open state for the more-actions dropdown. The action bar keys
  // its visibility off this (see below) so the portaled menu isn't torn down
  // when the pointer leaves the row to move onto the menu.
  const [menuOpen, setMenuOpen] = useState(false);
  // Inline-edit state lives on the row itself — there is no shared editing
  // store in Banter (channel.store has no editingMessageId), and only one
  // message edits at a time per row, so local state is the simplest correct
  // place for it. `editValue` seeds the textarea from the current content.
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const openThread = useChannelStore((s) => s.openThread);
  const currentUser = useAuthStore((s) => s.user);
  const toggleReaction = useToggleReaction();
  const deleteMessage = useDeleteMessage();
  const editMessage = useEditMessage();
  const pinMessage = usePinMessage();
  const bookmarkMessage = useBookmark();
  const removeBookmark = useRemoveBookmarkByMessage();

  // Pin and Bookmark land their result on other surfaces (the channel's pins
  // panel / the Bookmarks page), so without a tiny inline confirmation a click
  // looks like it did nothing. `feedback` shows a brief pill; it also surfaces
  // the failure case — the pin endpoint is channel-admin-gated, so a member's
  // click would otherwise 403 in silence.
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (msg: string) => {
    setFeedback(msg);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1800);
  };
  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  const startEditing = () => {
    setEditValue(message.content);
    setIsEditing(true);
    setMenuOpen(false);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditValue(message.content);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === message.content) {
      cancelEditing();
      return;
    }
    editMessage.mutate(
      { channelId, messageId: message.id, content: trimmed },
      { onSuccess: () => setIsEditing(false) },
    );
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  };

  const handlePin = () => {
    setMenuOpen(false);
    pinMessage.mutate(
      { channelId, messageId: message.id },
      {
        onSuccess: () => flash('Pinned to channel'),
        onError: () => flash("Couldn't pin — channel admins only"),
      },
    );
  };

  const handleBookmark = () => {
    setMenuOpen(false);
    if (message.is_bookmarked) {
      removeBookmark.mutate(
        { messageId: message.id, channelId },
        {
          onSuccess: () => flash('Bookmark removed'),
          onError: () => flash("Couldn't remove bookmark"),
        },
      );
    } else {
      bookmarkMessage.mutate(
        { messageId: message.id, channelId },
        {
          onSuccess: () => flash('Bookmarked'),
          onError: () => flash("Couldn't bookmark"),
        },
      );
    }
  };

  const isOwn = currentUser?.id === message.author_id;
  // Enforce the server's edit_permission policy in the UI too. 'none'
  // hides the Edit action entirely; 'thread_starter' only matters when
  // the row belongs to a thread (server-side check is authoritative) —
  // conservatively hide Edit unless the current user authored the row,
  // since the UI doesn't know the thread-starter identity here.
  const editPermission = message.edit_permission ?? 'own';
  const canEdit = isOwn && editPermission !== 'none';

  // System messages: centered, muted — with special call event styling
  if (message.is_system) {
    const isCallEvent = message.content.includes('call') || message.content.includes('huddle');
    const isCallStarted = message.content.includes('started');
    const isCallEnded = message.content.includes('ended');
    const isMissedCall = message.content.includes('missed');

    const CallIcon = isMissedCall
      ? PhoneMissed
      : isCallEnded
        ? PhoneOff
        : isCallStarted
          ? Phone
          : null;

    return (
      <div className="flex items-center justify-center gap-2 py-2">
        {isCallEvent && CallIcon && (
          <CallIcon className={cn(
            'h-3.5 w-3.5',
            isMissedCall ? 'text-red-400' : isCallEnded ? 'text-zinc-400' : 'text-green-500',
          )} />
        )}
        <p className={cn(
          'text-xs italic',
          isMissedCall ? 'text-red-400' : 'text-zinc-500',
        )}>
          {message.content}
        </p>
      </div>
    );
  }

  const renderedHtml = sanitizeHtml(markdownToHtml(message.content));

  return (
    <div
      className={cn(
        'group relative flex gap-3 rounded-md px-2 -mx-2 transition-colors',
        hovered && 'bg-zinc-50 dark:bg-zinc-800/50',
        grouped ? 'py-0.5' : 'py-2',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setShowEmojiPicker(false);
      }}
    >
      {/* Avatar column */}
      <div className="w-9 flex-shrink-0">
        {!grouped && (
          <div className="h-9 w-9 rounded-lg bg-primary-600 flex items-center justify-center text-white text-xs font-semibold">
            {message.author_avatar_url ? (
              <img
                src={message.author_avatar_url}
                alt={message.author_display_name}
                className="h-9 w-9 rounded-lg object-cover"
              />
            ) : (
              generateAvatarInitials(message.author_display_name)
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <UserProfilePopover
              userId={message.author_id}
              displayName={message.author_display_name}
              avatarUrl={message.author_avatar_url}
            >
              <button className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 hover:underline cursor-pointer">
                {message.author_display_name}
              </button>
            </UserProfilePopover>
            {message.is_bot && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400">
                <Bot className="h-3 w-3" />
                BOT
              </span>
            )}
            <span
              className="text-xs text-zinc-400 cursor-default"
              title={formatAbsoluteTime(message.created_at)}
            >
              {formatMessageTime(message.created_at)}
            </span>
            {message.is_edited && (
              <span className="text-xs text-zinc-400 italic">(edited)</span>
            )}
            {message.edit_permission === 'none' && (
              <span
                title="This message is locked — nobody may edit it."
                className="inline-flex items-center gap-0.5 text-zinc-400"
              >
                <Lock className="h-3 w-3" />
              </span>
            )}
            {message.edit_permission === 'thread_starter' && (
              <span
                title="Only the thread starter may edit this message."
                className="inline-flex items-center gap-0.5 text-amber-500"
              >
                <Crown className="h-3 w-3" />
              </span>
            )}
          </div>
        )}

        {/* Message body — inline editor when editing, rendered HTML otherwise */}
        {isEditing ? (
          <div className="mt-0.5">
            <textarea
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleEditKeyDown}
              rows={Math.min(editValue.split('\n').length, 8)}
              className={cn(
                'w-full resize-none rounded-md border border-zinc-300 dark:border-zinc-600',
                'bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm',
                'text-zinc-900 dark:text-zinc-100',
                'outline-none focus:border-primary-400 dark:focus:border-primary-600',
              )}
            />
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={saveEdit}
                disabled={editMessage.isPending}
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                Save
              </button>
              <button
                onClick={cancelEditing}
                className="px-2.5 py-1 rounded-md text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <span className="text-[10px] text-zinc-400">
                <kbd className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 font-mono">Enter</kbd> to save,{' '}
                <kbd className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 font-mono">Esc</kbd> to cancel
              </span>
            </div>
          </div>
        ) : (
          <div
            className="rich-text-content text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}

        {/* Cross-product embeds (Bam task, Bond deal previews) */}
        {!message.is_system && (
          <CrossProductEmbeds content={message.content} />
        )}

        {/* Link previews (og:title, og:image for external URLs) */}
        {!message.is_system && message.has_link_preview && (
          <LinkPreviews content={message.content} />
        )}

        {/* Attachments */}
        {message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1.5">
            {message.attachments.map((att) => (
              <a
                key={att.id}
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm"
              >
                <span className="truncate max-w-[200px]">{att.filename}</span>
                <span className="text-xs text-zinc-400">
                  {(att.size / 1024).toFixed(0)}KB
                </span>
              </a>
            ))}
          </div>
        )}

        {/* Reactions */}
        {message.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {message.reactions.map((reaction) => (
              <ReactionBadge
                key={reaction.emoji}
                reaction={reaction}
                channelId={channelId}
                messageId={message.id}
              />
            ))}
          </div>
        )}

        {/* Thread indicator */}
        {message.thread_reply_count > 0 && (
          <button
            onClick={() => openThread(message.id)}
            className="flex items-center gap-1.5 mt-1.5 text-xs text-primary-500 hover:text-primary-400 hover:underline transition-colors"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {message.thread_reply_count} {message.thread_reply_count === 1 ? 'reply' : 'replies'}
          </button>
        )}

        {/* Transient confirmation for Pin / Bookmark (they have no inline state) */}
        {feedback && (
          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
            {feedback}
          </div>
        )}
      </div>

      {/* Hover actions — always mounted, shown on row hover/focus (CSS) or
          while the more-menu is open. Previously this whole bar was gated on
          the React `hovered` flag, which unmounted the portaled dropdown the
          instant the pointer moved off the row onto the menu, so the menu
          flashed open and closed before anything could be clicked. */}
        <div
          className={cn(
            'absolute -top-3 right-2 flex items-center gap-0.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-sm p-0.5',
            'opacity-0 pointer-events-none transition-opacity duration-100',
            'group-hover:opacity-100 group-hover:pointer-events-auto',
            'focus-within:opacity-100 focus-within:pointer-events-auto',
            menuOpen && 'opacity-100 pointer-events-auto',
          )}
        >
          {/* Quick emoji */}
          <div className="relative">
            <ActionButton
              icon={<SmilePlus className="h-4 w-4" />}
              title="Add reaction"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            />
            {showEmojiPicker && (
              <div className="absolute top-full right-0 mt-1 flex gap-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg p-1.5 z-50">
                {QUICK_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      toggleReaction.mutate({
                        channelId,
                        messageId: message.id,
                        emoji,
                      });
                      setShowEmojiPicker(false);
                    }}
                    className="h-8 w-8 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-lg transition-colors"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Reply in thread */}
          <ActionButton
            icon={<MessageSquare className="h-4 w-4" />}
            title="Reply in thread"
            onClick={() => openThread(message.id)}
          />

          {/* Pin */}
          <ActionButton
            icon={<Pin className="h-4 w-4" />}
            title="Pin message"
            onClick={handlePin}
          />

          {/* Bookmark — filled + tinted when the current user has bookmarked it */}
          <ActionButton
            icon={
              <Bookmark className={cn('h-4 w-4', message.is_bookmarked && 'fill-current')} />
            }
            title={message.is_bookmarked ? 'Remove bookmark' : 'Bookmark'}
            onClick={handleBookmark}
            active={message.is_bookmarked}
          />

          {/* More menu */}
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[160px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg p-1 z-50"
                sideOffset={4}
                align="end"
              >
                {canEdit && (
                  <DropdownMenu.Item
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 outline-none"
                    onSelect={startEditing}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit message
                  </DropdownMenu.Item>
                )}
                {isOwn && (
                  <DropdownMenu.Item
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 outline-none"
                    onClick={() =>
                      deleteMessage.mutate({ channelId, messageId: message.id })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete message
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 outline-none"
                  onSelect={handleBookmark}
                >
                  <Bookmark className={cn('h-4 w-4', message.is_bookmarked && 'fill-current text-primary-500')} />
                  {message.is_bookmarked ? 'Remove bookmark' : 'Bookmark'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 outline-none"
                  onSelect={handlePin}
                >
                  <Pin className="h-4 w-4" />
                  Pin to channel
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
    </div>
  );
}

function ActionButton({
  icon,
  title,
  onClick,
  active = false,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'p-1.5 rounded-md transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-700',
        active
          ? 'text-primary-500 hover:text-primary-600'
          : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300',
      )}
    >
      {icon}
    </button>
  );
}

function ReactionBadge({
  reaction,
  channelId,
  messageId,
}: {
  reaction: Reaction;
  channelId: string;
  messageId: string;
}) {
  const toggleReaction = useToggleReaction();

  return (
    <button
      onClick={() =>
        toggleReaction.mutate({ channelId, messageId, emoji: reaction.emoji })
      }
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors',
        reaction.me
          ? 'bg-primary-50 dark:bg-primary-900/30 border-primary-300 dark:border-primary-700 text-primary-700 dark:text-primary-300'
          : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700',
      )}
    >
      <span>{reaction.emoji}</span>
      <span className="font-medium">{reaction.count}</span>
    </button>
  );
}
