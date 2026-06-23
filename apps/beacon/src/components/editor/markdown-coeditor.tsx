import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { yCollab } from 'y-codemirror.next';

// ---------------------------------------------------------------------------
// CodeMirror 6 markdown editor bound to a Yjs Y.Text for T4 co-editing.
//
// Beacon stores markdown, so the collaborative document is a plain Y.Text
// ('body') of the markdown source — no rich-text / HTML round-trip that could
// corrupt existing articles. y-codemirror.next's yCollab provides the CRDT
// binding plus live remote cursors + selections (driven by the provider's
// awareness `user` field set in use-collaboration). Yjs owns undo/redo, so
// CodeMirror's own history is NOT installed (it would fight the CRDT).
//
// The view is created only once the shared Y.Text has been populated by the
// provider's first sync (or a short grace window for a genuinely empty doc).
// Binding CodeMirror to a Y.Text that is still empty and then receiving the
// seed/persisted content moments later desyncs yCollab — the view stays blank
// while the document fills up. Waiting for content sidesteps that race without
// depending on the provider's `sync` event, which the custom WS server does
// not surface reliably.
// ---------------------------------------------------------------------------

interface MarkdownCoeditorProps {
  ydoc: Y.Doc;
  provider: WebsocketProvider | null;
  editable: boolean;
}

const GRACE_MS = 1500; // mount an empty editor after this if no content arrives

const editorTheme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    minHeight: '320px',
    caretColor: 'currentColor',
  },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'rgba(120,120,120,0.6)' },
  '.cm-scroller': { overflow: 'auto', maxHeight: '60vh', lineHeight: '1.6' },
  '.cm-activeLine': { backgroundColor: 'rgba(120,120,120,0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
});

export function MarkdownCoeditor({ ydoc, provider, editable }: MarkdownCoeditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!hostRef.current || !provider) return;
    const ytext = ydoc.getText('body');
    let view: EditorView | null = null;
    let undoManager: Y.UndoManager | null = null;
    let graceTimer: number | null = null;
    let done = false;

    const build = () => {
      if (done || !hostRef.current) return;
      done = true;
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      ytext.unobserve(onContent);
      undoManager = new Y.UndoManager(ytext);
      const state = EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          // CRDT binding + remote cursors/selections. The Yjs undo manager scopes
          // Cmd/Ctrl+Z to THIS user's changes, not everyone's.
          yCollab(ytext, provider.awareness, { undoManager }),
          editorTheme,
        ],
      });
      view = new EditorView({ state, parent: hostRef.current });
      setMounted(true);
    };

    const onContent = () => {
      if (ytext.length > 0) build();
    };

    if (ytext.length > 0) {
      build();
    } else {
      // Wait for the first sync to deliver content; if it never does (a truly
      // empty article), mount an empty editor after the grace window.
      ytext.observe(onContent);
      graceTimer = window.setTimeout(build, GRACE_MS);
    }

    return () => {
      done = true;
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      ytext.unobserve(onContent);
      view?.destroy();
      undoManager?.destroy();
      setMounted(false);
    };
  }, [ydoc, provider, editable]);

  return (
    <div className="relative">
      <div
        ref={hostRef}
        className="rounded-lg border border-zinc-300 bg-white text-zinc-900 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 overflow-hidden min-h-[200px]"
      />
      {!mounted && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
          Connecting to live editing session…
        </div>
      )}
    </div>
  );
}
