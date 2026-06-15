import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';

// Brief-specific extensions
import { Mention } from '../../extensions/mention.js';
import { TaskEmbed } from '../../extensions/task-embed.js';
import { BeaconEmbed } from '../../extensions/beacon-embed.js';
import { Callout } from '../../extensions/callout.js';
import { SlashCommand } from '../../extensions/slash-command.js';
import { ChannelLink } from '../../extensions/channel-link.js';
// bubble-menu-config is a UI component config, not an extension -- it is
// consumed by the toolbar/BubbleMenu wrapper, not added to the extensions
// array. Imported here for re-export convenience.
export { bubbleMenuConfig, BubbleMenu } from '../../extensions/bubble-menu-config.js';

import { createSuggestionRenderer } from './suggestion-popup.js';

const lowlight = createLowlight(common);

interface BriefEditorProps {
  content: string;
  onUpdate: (html: string) => void;
  editable?: boolean;
  onEditorReady?: (editor: Editor) => void;
}

/**
 * Shared set of Tiptap extensions used by both standalone and collaborative
 * modes. The caller passes `collaborative` options when a Yjs document and
 * provider are available; otherwise the editor runs in single-user mode.
 */
function buildExtensions(options?: {
  ydoc?: Y.Doc;
  provider?: WebsocketProvider | null;
  fieldName?: string;
  /** Cursor identity broadcast to peers (name + color). MUST be passed so
   *  CollaborationCursor's plugin init seeds the awareness with the real name
   *  instead of its `{ name: null }` default (which renders as "User: <id>"). */
  cursorUser?: { name: string; color: string } | null;
}) {
  const extensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: false,
      horizontalRule: false,
      // When collaborative mode is active, Yjs handles history (undo/redo).
      // Disable the built-in history extension to avoid conflicts.
      ...(options?.ydoc ? { history: false } : {}),
    }),
    Placeholder.configure({
      placeholder: 'Start writing...',
    }),
    Image.configure({
      inline: false,
      allowBase64: true,
    }),
    Link.configure({
      autolink: true,
      openOnClick: true,
      HTMLAttributes: {
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    Highlight,
    Typography,
    Underline,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    CodeBlockLowlight.configure({
      lowlight,
    }),
    HorizontalRule,

    // Brief-specific extensions -------------------------------------------

    // @mention with suggestion popup
    Mention.configure({
      suggestion: {
        char: '@',
        allowSpaces: false,
        items: async () => [],
        render: createSuggestionRenderer,
      },
    }),

    // Inline task embed node
    TaskEmbed,

    // Inline Beacon knowledge base embed node
    BeaconEmbed,

    // Block-level callout container (info/warning/tip/success)
    Callout,

    // Slash command palette (triggered by '/')
    SlashCommand.configure({
      suggestion: {
        render: createSuggestionRenderer,
      },
    }),

    // Inline #channel link node
    ChannelLink,
  ];

  if (options?.ydoc) {
    extensions.push(
      Collaboration.configure({
        document: options.ydoc,
        field: options.fieldName ?? 'default',
      }) as any,
    );

    if (options.provider) {
      extensions.push(
        CollaborationCursor.configure({
          provider: options.provider,
          // Seed the extension's awareness `user` with the real identity; its
          // plugin init writes this.options.user into awareness, clobbering any
          // earlier setLocalStateField, so without this every peer is "User: <id>".
          ...(options.cursorUser ? { user: options.cursorUser } : {}),
          // Self-contained render: a thin insert caret at the peer's position
          // plus a small name pill. The default render emits a bare
          // `.collaboration-cursor__label` <div> that, with no CSS shipped here,
          // lays out as a full-width block bar, and falls back to "User: <id>"
          // when the awareness name is missing. We inline the styles (so it
          // never depends on a stylesheet) and show the peer's name.
          render: (user: { name?: string; color?: string }) => {
            const color = user.color || '#6366f1';
            const name =
              typeof user.name === 'string' && user.name.trim()
                ? user.name.trim()
                : 'Someone';
            const caret = document.createElement('span');
            caret.classList.add('collaboration-cursor__caret');
            caret.setAttribute(
              'style',
              [
                `border-left: 1px solid ${color}`,
                `border-right: 1px solid ${color}`,
                'margin-left: -1px',
                'margin-right: -1px',
                'position: relative',
                'box-sizing: border-box',
                'word-break: normal',
                'pointer-events: none',
              ].join(';'),
            );
            const label = document.createElement('div');
            label.classList.add('collaboration-cursor__label');
            label.textContent = name;
            label.setAttribute(
              'style',
              [
                'position: absolute',
                'top: -1.3em',
                'left: -1px',
                'white-space: nowrap',
                'font-size: 11px',
                'line-height: 1.4',
                'font-weight: 600',
                'border-radius: 6px',
                'padding: 1px 6px',
                'color: #fff',
                `background: ${color}`,
                'user-select: none',
                'pointer-events: none',
              ].join(';'),
            );
            caret.appendChild(label);
            return caret;
          },
        }) as any,
      );
    }
  }

  return extensions;
}

export function useBriefEditor({
  content,
  onUpdate,
  editable = true,
  key: _key,
}: {
  content: string;
  onUpdate: (html: string) => void;
  editable?: boolean;
  /** Change this value to force the editor to re-create with new content */
  key?: string;
}) {
  const editor = useEditor({
    extensions: buildExtensions(),
    content,
    editable,
    editorProps: {
      attributes: {
        class: 'prose-editor focus:outline-none',
      },
    },
    onUpdate: ({ editor: e }) => {
      onUpdate(e.getHTML());
    },
  });

  return editor;
}

/**
 * Collaborative variant of the Brief editor hook. Binds to a shared Y.Doc
 * so all connected clients see edits in real time.
 *
 * When `ydoc` is provided the editor skips the `content` prop (Yjs owns the
 * initial document state). Non-collaborative fallback: pass ydoc=undefined.
 */
export function useCollaborativeEditor({
  ydoc,
  provider,
  onUpdate,
  editable = true,
  fieldName,
  cursorUser,
}: {
  ydoc: Y.Doc | undefined;
  provider: WebsocketProvider | null | undefined;
  onUpdate: (html: string) => void;
  editable?: boolean;
  fieldName?: string;
  cursorUser?: { name: string; color: string } | null;
}) {
  const editor = useEditor(
    {
      extensions: buildExtensions(
        ydoc ? { ydoc, provider: provider ?? null, fieldName, cursorUser } : undefined,
      ),
      // When collaborative, the content comes from Yjs. Passing empty string
      // avoids overwriting the shared document with stale HTML.
      content: ydoc ? '' : undefined,
      editable,
      editorProps: {
        attributes: {
          class: 'prose-editor focus:outline-none',
        },
      },
      onUpdate: ({ editor: e }) => {
        onUpdate(e.getHTML());
      },
    },
    // Re-create the editor when the ydoc or provider instance changes
    [ydoc, provider],
  );

  return editor;
}

interface BriefEditorContentProps {
  editor: Editor | null;
}

export function BriefEditorContent({ editor }: BriefEditorContentProps) {
  if (!editor) return null;

  return (
    <div className="brief-editor flex-1 overflow-auto">
      <EditorContent editor={editor} className="h-full" />
    </div>
  );
}

export type { BriefEditorProps };
