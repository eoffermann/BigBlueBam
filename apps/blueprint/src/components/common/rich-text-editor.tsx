import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Bold,
  Italic,
  Code,
  Link,
  Heading2,
  List,
  ImagePlus,
  Eye,
  EyeOff,
  Loader2,
} from 'lucide-react';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  onImageUpload?: (file: File) => Promise<string>;
  className?: string;
  /** Show a reduced toolbar (for compact use like comments) */
  compact?: boolean;
  /** Default to preview mode — overrides the auto-detect */
  defaultPreview?: boolean;
}

type FormatAction = 'bold' | 'italic' | 'code' | 'link' | 'heading' | 'list' | 'image';

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write something...',
  minRows = 4,
  onImageUpload,
  className,
  compact = false,
  defaultPreview,
}: RichTextEditorProps) {
  const [preview, setPreview] = useState(() => defaultPreview ?? !!value?.trim());
  const [hasInitialized, setHasInitialized] = useState(false);

  // When value loads asynchronously (e.g., from API), switch to preview if it has content
  useEffect(() => {
    if (!hasInitialized && value?.trim()) {
      setPreview(true);
      setHasInitialized(true);
    }
  }, [value, hasInitialized]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const wrapSelection = useCallback(
    (before: string, after: string) => {
      const ta = textareaRef.current;
      if (!ta) return;

      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = value.slice(start, end);
      const replacement = `${before}${selected || 'text'}${after}`;
      const newValue = value.slice(0, start) + replacement + value.slice(end);
      onChange(newValue);

      // Restore cursor position after React re-render
      requestAnimationFrame(() => {
        ta.focus();
        const cursorPos = selected
          ? start + replacement.length
          : start + before.length;
        ta.setSelectionRange(cursorPos, cursorPos + (selected ? 0 : 4));
      });
    },
    [value, onChange],
  );

  const prependLine = useCallback(
    (prefix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;

      const start = ta.selectionStart;
      // Find the start of the current line
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const newValue = value.slice(0, lineStart) + prefix + value.slice(lineStart);
      onChange(newValue);

      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start + prefix.length, start + prefix.length);
      });
    },
    [value, onChange],
  );

  const handleFormat = useCallback(
    (action: FormatAction) => {
      switch (action) {
        case 'bold':
          wrapSelection('**', '**');
          break;
        case 'italic':
          wrapSelection('*', '*');
          break;
        case 'code':
          wrapSelection('`', '`');
          break;
        case 'link': {
          const ta = textareaRef.current;
          if (!ta) return;
          const selected = value.slice(ta.selectionStart, ta.selectionEnd);
          const linkText = selected || 'link text';
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          const replacement = `[${linkText}](url)`;
          const newValue = value.slice(0, start) + replacement + value.slice(end);
          onChange(newValue);
          requestAnimationFrame(() => {
            ta.focus();
            // Select "url" so user can type the actual URL
            const urlStart = start + linkText.length + 3;
            ta.setSelectionRange(urlStart, urlStart + 3);
          });
          break;
        }
        case 'heading':
          prependLine('## ');
          break;
        case 'list':
          prependLine('- ');
          break;
        case 'image':
          fileInputRef.current?.click();
          break;
      }
    },
    [wrapSelection, prependLine, value, onChange],
  );

  const handleImageFile = useCallback(
    async (file: File) => {
      if (!onImageUpload) return;

      setUploading(true);
      try {
        const url = await onImageUpload(file);
        const ta = textareaRef.current;
        const pos = ta?.selectionStart ?? value.length;
        const imageMarkdown = `![image](${url})`;
        const newValue = value.slice(0, pos) + imageMarkdown + value.slice(pos);
        onChange(newValue);
      } catch (err) {
        console.error('Image upload failed:', err);
      } finally {
        setUploading(false);
      }
    },
    [onImageUpload, value, onChange],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      e.target.value = '';
      handleImageFile(file);
    }
  };

  const toolbarButtons: { action: FormatAction; icon: React.ReactNode; label: string; compactHide?: boolean }[] = [
    { action: 'bold', icon: <Bold className="h-3.5 w-3.5" />, label: 'Bold' },
    { action: 'italic', icon: <Italic className="h-3.5 w-3.5" />, label: 'Italic' },
    { action: 'code', icon: <Code className="h-3.5 w-3.5" />, label: 'Code' },
    { action: 'link', icon: <Link className="h-3.5 w-3.5" />, label: 'Link' },
    { action: 'heading', icon: <Heading2 className="h-3.5 w-3.5" />, label: 'Heading', compactHide: true },
    { action: 'list', icon: <List className="h-3.5 w-3.5" />, label: 'List', compactHide: true },
    ...(onImageUpload
      ? [{ action: 'image' as FormatAction, icon: <ImagePlus className="h-3.5 w-3.5" />, label: 'Image' }]
      : []),
  ];

  const visibleButtons = compact
    ? toolbarButtons.filter((b) => !b.compactHide)
    : toolbarButtons;

  const previewHtml = sanitizeHtml(markdownToHtml(value));

  return (
    <div className={`rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden ${className ?? ''}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
        {visibleButtons.map((btn) => (
          <button
            key={btn.action}
            type="button"
            onClick={() => handleFormat(btn.action)}
            disabled={uploading}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/60 dark:hover:text-zinc-300 dark:hover:bg-zinc-700/60 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            title={btn.label}
            aria-label={btn.label}
          >
            {btn.action === 'image' && uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              btn.icon
            )}
          </button>
        ))}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setPreview(!preview)}
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/60 dark:hover:text-zinc-300 dark:hover:bg-zinc-700/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          title={preview ? 'Edit' : 'Preview'}
          aria-label={preview ? 'Switch to edit mode' : 'Switch to preview mode'}
          aria-pressed={preview}
        >
          {preview ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>

      {/* Editor / Preview */}
      {preview ? (
        <div
          className="rich-text-content p-3 min-h-[80px] text-sm text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={minRows}
          className="w-full p-3 text-sm bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none resize-y"
        />
      )}

      {/* Hidden file input for image upload */}
      {onImageUpload && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileInputChange}
        />
      )}
    </div>
  );
}
