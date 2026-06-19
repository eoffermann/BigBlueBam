import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import {
  Bold,
  Italic,
  Code,
  Link,
  Paperclip,
  Smile,
  Send,
} from 'lucide-react';
import { usePostMessage } from '@/hooks/use-messages';
import { useChannelMembers, type ChannelMember } from '@/hooks/use-channels';
import { useSendTyping } from '@/hooks/use-typing';
import { useChannelStore } from '@/stores/channel.store';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const COMMON_EMOJIS = [
  '😀', '😂', '🥲', '😍', '🤔', '👍', '👎', '❤️',
  '🎉', '🚀', '🔥', '💯', '👀', '🙏', '✅', '❌',
  '⭐', '💡', '🐛', '📝', '🤖', '☕', '🏗️', '🎯',
];

interface MessageComposeProps {
  channelId: string;
  channelName: string;
}

/**
 * Shape returned by POST /v1/files/upload. There is NO `id` field — banter
 * file uploads store the object in MinIO and hand back its storage key plus
 * metadata; the per-message attachment row is created server-side at
 * message-post time (banter_message_attachments). The compose flow therefore
 * carries this descriptor (not a non-existent id) through to the post call.
 */
interface UploadedAttachment {
  key: string;
  url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export function MessageCompose({ channelId, channelName }: MessageComposeProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const postMessage = usePostMessage();
  const { sendTyping } = useSendTyping(channelId);
  const draftMessages = useChannelStore((s) => s.draftMessages);
  const setDraft = useChannelStore((s) => s.setDraft);
  const clearDraft = useChannelStore((s) => s.clearDraft);

  const [content, setContent] = useState(draftMessages[channelId] ?? '');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const { data: members } = useChannelMembers(channelId);

  // Restore draft when switching channels
  useEffect(() => {
    setContent(draftMessages[channelId] ?? '');
  }, [channelId, draftMessages]);

  // Save draft as user types
  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      setDraft(channelId, value);
      sendTyping();

      // Check for @mention trigger
      const cursorPos = textareaRef.current?.selectionStart ?? 0;
      const textBeforeCursor = value.slice(0, cursorPos);
      const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
      if (mentionMatch) {
        setShowMentions(true);
        setMentionQuery(mentionMatch[1]!);
      } else {
        setShowMentions(false);
      }
    },
    [channelId, setDraft, sendTyping],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed && attachments.length === 0) return;

    postMessage.mutate(
      {
        channelId,
        content: trimmed,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      {
        onSuccess: () => {
          setContent('');
          clearDraft(channelId);
          setAttachments([]);
          textareaRef.current?.focus();
        },
      },
    );
  }, [content, channelId, attachments, postMessage, clearDraft]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        const result = await api.upload<{ data: UploadedAttachment }>('/files/upload', formData);
        // The upload response carries { key, url, filename, content_type,
        // size_bytes } — NOT an id. Carry the whole descriptor; the message
        // post turns each into a banter_message_attachments row.
        setAttachments((prev) => [...prev, result.data]);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const insertMarkdown = (wrapper: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = content.slice(start, end);
    const replacement = `${wrapper}${selected || 'text'}${wrapper}`;
    const newContent = content.slice(0, start) + replacement + content.slice(end);

    setContent(newContent);
    setDraft(channelId, newContent);

    // Move cursor inside wrapper
    setTimeout(() => {
      textarea.focus();
      const cursorPos = start + wrapper.length;
      textarea.setSelectionRange(cursorPos, cursorPos + (selected.length || 4));
    }, 0);
  };

  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    const pos = textarea?.selectionStart ?? content.length;
    const newContent = content.slice(0, pos) + emoji + content.slice(pos);
    setContent(newContent);
    setDraft(channelId, newContent);
    setShowEmoji(false);
    textarea?.focus();
  };

  const insertMention = (member: ChannelMember) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = content.slice(0, cursorPos);
    const mentionStart = textBeforeCursor.lastIndexOf('@');
    // Insert the canonical handle (slugified display_name), NOT the raw name.
    // "Jonas Grumby" → `@jonas-grumby`. The raw-name form ("@Jonas Grumby")
    // broke server-side resolution: the parser captured only "Jonas" (it
    // stopped at the space) and then tried to match it against the FULL
    // lower-cased display_name, which never hit. This slug MUST match the
    // server's handle transform (apps/banter-api notification-queue
    // slugifyHandle + the /v1/users/by-handle SQL): lower-case, whitespace →
    // '-', strip non-[a-z0-9-].
    const handle = member.display_name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    const newContent =
      content.slice(0, mentionStart) +
      `@${handle} ` +
      content.slice(cursorPos);

    setContent(newContent);
    setDraft(channelId, newContent);
    setShowMentions(false);
    textarea.focus();
  };

  const filteredMembers = members?.filter((m) =>
    m.display_name.toLowerCase().includes(mentionQuery.toLowerCase()),
  ) ?? [];

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [content]);

  return (
    <div className="relative px-4 pb-4">
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl bg-white dark:bg-zinc-800 focus-within:border-primary-400 dark:focus-within:border-primary-600 transition-colors">
        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-2 pt-2">
          <ToolbarButton icon={<Bold className="h-4 w-4" />} title="Bold" onClick={() => insertMarkdown('**')} />
          <ToolbarButton icon={<Italic className="h-4 w-4" />} title="Italic" onClick={() => insertMarkdown('*')} />
          <ToolbarButton icon={<Code className="h-4 w-4" />} title="Code" onClick={() => insertMarkdown('`')} />
          <ToolbarButton icon={<Link className="h-4 w-4" />} title="Link" onClick={() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const selected = content.slice(start, end);
            const insert = `[${selected || 'text'}](url)`;
            const newContent = content.slice(0, start) + insert + content.slice(end);
            setContent(newContent);
            setDraft(channelId, newContent);
          }} />
          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
          <ToolbarButton
            icon={<Paperclip className="h-4 w-4" />}
            title="Attach file"
            onClick={() => fileInputRef.current?.click()}
          />
          <div className="relative">
            <ToolbarButton
              icon={<Smile className="h-4 w-4" />}
              title="Emoji"
              onClick={() => setShowEmoji(!showEmoji)}
            />
            {showEmoji && (
              <div className="absolute bottom-full left-0 mb-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg p-2 grid grid-cols-8 gap-1 z-50 w-[280px]">
                {COMMON_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => insertEmoji(emoji)}
                    className="h-8 w-8 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-lg transition-colors"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message #${channelName}`}
          rows={1}
          className={cn(
            'w-full resize-none bg-transparent px-3 py-2 text-sm',
            'text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400',
            'outline-none',
          )}
        />

        {/* Attachment preview */}
        {attachments.length > 0 && (
          <div className="px-3 pb-2 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-zinc-500">
              {attachments.length} file{attachments.length > 1 ? 's' : ''} attached:
            </span>
            {attachments.map((att) => (
              <span
                key={att.key}
                className="text-xs text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-700 rounded px-1.5 py-0.5 truncate max-w-[160px]"
                title={att.filename}
              >
                {att.filename}
              </span>
            ))}
            <button
              onClick={() => setAttachments([])}
              className="text-xs text-red-500 hover:underline"
            >
              Remove all
            </button>
          </div>
        )}

        {uploading && (
          <div className="px-3 pb-2 text-xs text-zinc-500">Uploading...</div>
        )}

        {/* Send button row */}
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-xs text-zinc-400">
            <kbd className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-[10px] font-mono">Enter</kbd> to send, <kbd className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-[10px] font-mono">Shift+Enter</kbd> for newline
          </span>
          <button
            onClick={handleSubmit}
            disabled={!content.trim() && attachments.length === 0}
            className={cn(
              'p-1.5 rounded-lg transition-colors',
              content.trim() || attachments.length > 0
                ? 'bg-primary-600 text-white hover:bg-primary-700'
                : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-400 cursor-not-allowed',
            )}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* @mention dropdown */}
      {showMentions && filteredMembers.length > 0 && (
        <div className="absolute bottom-full left-4 mb-1 w-64 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg overflow-hidden z-50">
          {filteredMembers.slice(0, 8).map((member) => (
            <button
              key={member.id}
              onClick={() => insertMention(member)}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
            >
              <div className="h-6 w-6 rounded-md bg-primary-600 flex items-center justify-center text-white text-[10px] font-semibold flex-shrink-0">
                {member.avatar_url ? (
                  <img src={member.avatar_url} alt="" className="h-6 w-6 rounded-md object-cover" />
                ) : (
                  member.display_name.slice(0, 2).toUpperCase()
                )}
              </div>
              <span className="text-zinc-800 dark:text-zinc-200 truncate">{member.display_name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />
    </div>
  );
}

function ToolbarButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
    >
      {icon}
    </button>
  );
}
