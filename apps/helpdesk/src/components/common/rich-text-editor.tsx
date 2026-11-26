import { useState, useRef, useCallback, useEffect } from 'react';
import { Bold, Italic, Link, ImagePlus, Eye, EyeOff, Loader2 } from 'lucide-react';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  onImageUpload?: (file: File) => Promise<string>;
  className?: string;
}

type FormatAction = 'bold' | 'italic' | 'link' | 'image';

export function RichTextEditor({
  value,
  onChange: onChangeProp,
  placeholder = 'Write something...',
  minRows = 4,
  onImageUpload,
  className,
}: RichTextEditorProps) {
  const [preview, setPreview] = useState(() => !!value?.trim());
  const [uploading, setUploading] = useState(false);
  // Auto-switch to preview only when content arrives from outside (e.g. an
  // async-loaded existing body). Once the value is non-empty, or the user has
  // edited it, never flip modes again: flipping on the user's own first
  // keystroke unmounts the textarea and locks them out of typing.
  const initializedRef = useRef(!!value?.trim());

  const onChange = useCallback(
    (next: string) => {
      initializedRef.current = true;
      onChangeProp(next);
    },
    [onChangeProp],
  );

  useEffect(() => {
    if (!initializedRef.current && value?.trim()) {
      initializedRef.current = true;
      setPreview(true);
    }
  }, [value]);
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

      requestAnimationFrame(() => {
        ta.focus();
        const cursorPos = selected ? start + replacement.length : start + before.length;
        ta.setSelectionRange(cursorPos, cursorPos + (selected ? 0 : 4));
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
            const urlStart = start + linkText.length + 3;
            ta.setSelectionRange(urlStart, urlStart + 3);
          });
          break;
        }
        case 'image':
          fileInputRef.current?.click();
          break;
      }
    },
    [wrapSelection, value, onChange],
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

  const toolbarButtons: { action: FormatAction; icon: React.ReactNode; label: string }[] = [
    { action: 'bold', icon: <Bold className="h-3.5 w-3.5" />, label: 'Bold' },
    { action: 'italic', icon: <Italic className="h-3.5 w-3.5" />, label: 'Italic' },
    { action: 'link', icon: <Link className="h-3.5 w-3.5" />, label: 'Link' },
    ...(onImageUpload
      ? [{ action: 'image' as FormatAction, icon: <ImagePlus className="h-3.5 w-3.5" />, label: 'Image' }]
      : []),
  ];

  const previewHtml = sanitizeHtml(markdownToHtml(value));

  return (
    <div className={`rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden ${className ?? ''}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
        {toolbarButtons.map((btn) => (
          <button
            key={btn.action}
            type="button"
            onClick={() => handleFormat(btn.action)}
            disabled={uploading}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/60 dark:hover:text-zinc-300 dark:hover:bg-zinc-700/60 transition-colors disabled:opacity-50"
            title={btn.label}
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
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/60 dark:hover:text-zinc-300 dark:hover:bg-zinc-700/60 transition-colors"
          title={preview ? 'Edit' : 'Preview'}
        >
          {preview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
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
