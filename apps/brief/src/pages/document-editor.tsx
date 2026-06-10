import { useState, useEffect, useCallback } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';
import {
  useDocument,
  useCreateDocument,
  useUpdateDocument,
  type DocumentVisibility,
  type DocumentStatus,
} from '@/hooks/use-documents';
import { useTemplates } from '@/hooks/use-templates';
import { Button } from '@/components/common/button';
import { useProjectStore } from '@/stores/project.store';
import { useProjects } from '@/hooks/use-projects';
import { useBriefEditor, useCollaborativeEditor, BriefEditorContent } from '@/components/editor/brief-editor';
import { EditorToolbar } from '@/components/editor/editor-toolbar';
import { TableOfContents } from '@/components/editor/table-of-contents';
import { ExportMenu } from '@/components/document/export-menu';
import { markdownToHtml, htmlToMarkdown } from '@/lib/markdown';
import { useCollaboration } from '@/hooks/use-collaboration';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface DocumentEditorPageProps {
  idOrSlug?: string;
  onNavigate: (path: string) => void;
}

const VISIBILITY_OPTIONS: { value: DocumentVisibility; label: string }[] = [
  { value: 'public', label: 'Public' },
  { value: 'organization', label: 'Organization' },
  { value: 'project', label: 'Project' },
  { value: 'private', label: 'Private' },
];

export function DocumentEditorPage({ idOrSlug, onNavigate }: DocumentEditorPageProps) {
  const isEditMode = !!idOrSlug;
  const { data: existing, isLoading: loadingExisting } = useDocument(idOrSlug);
  const createDocument = useCreateDocument();
  const updateDocument = useUpdateDocument();
  const { projects } = useProjects();
  const { data: templates } = useTemplates();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  // Real-time collaboration via Yjs when editing an existing document
  const docIdForCollab = isEditMode && existing ? existing.id : null;
  const { ydoc, provider } = useCollaboration(docIdForCollab);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [iconEmoji, setIconEmoji] = useState('');
  const [projectId, setProjectId] = useState('');
  const [visibility, setVisibility] = useState<DocumentVisibility>('organization');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editorHtml, setEditorHtml] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [initialContent, setInitialContent] = useState<string | null>(null);

  // Pre-select the active project from the store when creating
  useEffect(() => {
    if (!isEditMode && activeProjectId && !projectId) {
      setProjectId(activeProjectId);
    }
  }, [isEditMode, activeProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up template selection from sessionStorage (set by template browser)
  useEffect(() => {
    if (!isEditMode && !selectedTemplateId) {
      try {
        const stored = sessionStorage.getItem('brief_selected_template');
        if (stored) {
          setSelectedTemplateId(stored);
          sessionStorage.removeItem('brief_selected_template');
        }
      } catch {
        // ignore
      }
    }
  }, [isEditMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Populate form when editing
  useEffect(() => {
    if (existing) {
      setTitle(existing.title);
      setSummary(existing.summary ?? '');
      setIconEmoji(existing.icon ?? '');
      setProjectId(existing.project_id ?? '');
      setVisibility(existing.visibility ?? 'organization');

      // Convert stored content to HTML for the editor
      const md = existing.plain_text ?? '';
      const html = markdownToHtml(md);
      setInitialContent(html);
      setEditorHtml(html);
    }
  }, [existing]);

  // Set initial content for new documents
  useEffect(() => {
    if (!isEditMode && initialContent === null) {
      setInitialContent('');
    }
  }, [isEditMode, initialContent]);

  // Apply template content when a template is selected (new documents only)
  useEffect(() => {
    if (!isEditMode && selectedTemplateId && templates) {
      const template = templates.find((t) => t.id === selectedTemplateId);
      if (template) {
        if (!title) setTitle(template.name);
        // Template content is already HTML (html_preview)
        const html = template.html_preview ?? '';
        setInitialContent(html);
        setEditorHtml(html);
        setIconEmoji(template.icon ?? '');
      }
    }
  }, [selectedTemplateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEditorUpdate = useCallback((html: string) => {
    setEditorHtml(html);
    // Count words from text content
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const text = tempDiv.textContent || '';
    const words = text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    setWordCount(words.length);
  }, []);

  // Wait for content to be ready before creating the editor.
  // Tiptap's `content` prop is only read on initialization; passing it
  // after the hook has already created the editor is a silent no-op.
  const contentReady = initialContent !== null;

  // Use the collaborative editor when editing an existing document (Yjs owns
  // the document state). Fall back to single-user mode for new documents.
  const collabEditor = useCollaborativeEditor({
    ydoc: docIdForCollab ? ydoc : undefined,
    provider: docIdForCollab ? provider : undefined,
    onUpdate: handleEditorUpdate,
    editable: true,
  });

  const standaloneEditor = useBriefEditor({
    content: contentReady ? initialContent : '',
    onUpdate: handleEditorUpdate,
    editable: true,
    key: contentReady ? 'loaded' : 'empty',
  });

  const editor = docIdForCollab ? collabEditor : standaloneEditor;

  // Sync content into existing editor when template changes or content is set
  useEffect(() => {
    if (editor && initialContent && editor.getHTML() !== initialContent) {
      editor.commands.setContent(initialContent);
    }
  }, [editor, initialContent]);

  if (isEditMode && (loadingExisting || !contentReady)) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  // Don't render editor until initial content is set
  if (initialContent === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  const handleSaveDraft = async () => {
    setSaveError(null);
    const bodyMarkdown = htmlToMarkdown(editorHtml);
    try {
      if (isEditMode && existing) {
        await updateDocument.mutateAsync({
          id: existing.id,
          data: {
            title,
            plain_text: bodyMarkdown,
            summary: summary || undefined,
            icon: iconEmoji || undefined,
            visibility,
            status: 'draft' as DocumentStatus,
          },
        });
        onNavigate(`/documents/${idOrSlug}`);
      } else {
        const res = await createDocument.mutateAsync({
          title,
          plain_text: bodyMarkdown,
          summary: summary || undefined,
          icon: iconEmoji || undefined,
          project_id: projectId || undefined,
          template_id: selectedTemplateId || undefined,
          visibility,
          status: 'draft',
        });
        onNavigate(`/documents/${res.data.slug ?? res.data.id}`);
      }
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save');
    }
  };

  const handlePublish = async () => {
    setSaveError(null);
    const bodyMarkdown = htmlToMarkdown(editorHtml);
    try {
      if (isEditMode && existing) {
        await updateDocument.mutateAsync({
          id: existing.id,
          data: {
            title,
            plain_text: bodyMarkdown,
            summary: summary || undefined,
            icon: iconEmoji || undefined,
            visibility,
            status: 'approved' as DocumentStatus,
          },
        });
        onNavigate(`/documents/${idOrSlug}`);
      } else {
        const res = await createDocument.mutateAsync({
          title,
          plain_text: bodyMarkdown,
          summary: summary || undefined,
          icon: iconEmoji || undefined,
          project_id: projectId || undefined,
          template_id: selectedTemplateId || undefined,
          visibility,
          status: 'approved',
        });
        onNavigate(`/documents/${res.data.slug ?? res.data.id}`);
      }
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to publish');
    }
  };

  const isSaving = createDocument.isPending || updateDocument.isPending;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => onNavigate(isEditMode ? `/documents/${idOrSlug}` : '/documents')}
            className="rounded-md p-1.5 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <label htmlFor="brief-document-title" className="sr-only">
            Title
          </label>
          <input
            id="brief-document-title"
            type="text"
            placeholder="Document title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="flex-1 text-lg font-semibold bg-transparent border-0 outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 min-w-0"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isEditMode && existing && (
            <PresenceChipStrip
              url={`${window.location.origin}${window.location.pathname}`}
              surfaceApp="brief"
              surfaceId={existing.id}
              surfaceLabel={existing.title}
            />
          )}
          {isEditMode && existing && (
            <ExportMenu documentId={existing.id} slug={existing.slug} />
          )}
          <Button variant="secondary" size="sm" onClick={handleSaveDraft} loading={isSaving} disabled={!title.trim()}>
            Save Draft
          </Button>
          <Button size="sm" onClick={handlePublish} loading={isSaving} disabled={!title.trim()}>
            Publish
          </Button>
        </div>
      </div>

      {saveError && (
        <div className="mx-6 mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          {saveError}
        </div>
      )}

      {/* Content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Toolbar */}
          <EditorToolbar editor={editor} />

          {/* Summary (collapsed, optional) */}
          <div className="px-6 lg:px-8 pt-4 pb-2 shrink-0">
            <label htmlFor="brief-document-summary" className="sr-only">
              Summary
            </label>
            <input
              id="brief-document-summary"
              type="text"
              placeholder="Brief summary (optional)..."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="w-full max-w-3xl text-sm bg-transparent border-0 outline-none text-zinc-500 dark:text-zinc-400 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
            />
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-auto px-6 lg:px-8 pb-6">
            <div className="max-w-3xl mx-auto">
              <BriefEditorContent editor={editor} />
            </div>
          </div>

          {/* Word count footer */}
          <div className="shrink-0 px-6 py-2 border-t border-zinc-100 dark:border-zinc-800 text-xs text-zinc-400 dark:text-zinc-500">
            {wordCount.toLocaleString()} {wordCount === 1 ? 'word' : 'words'}
          </div>
        </div>

        {/* Right sidebar */}
        <aside className="w-72 shrink-0 border-l border-zinc-200 dark:border-zinc-800 overflow-auto p-5 hidden lg:block">
          <div className="space-y-5">
            {/* Table of Contents */}
            <TableOfContents editor={editor} />

            {/* Divider */}
            <div className="border-t border-zinc-200 dark:border-zinc-800" />

            {/* Settings section header */}
            <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              Settings
            </h3>

            {/* Icon emoji */}
            <div>
              <label htmlFor="brief-document-icon" className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
                Icon (emoji)
              </label>
              <input
                id="brief-document-icon"
                type="text"
                placeholder="e.g. docs, notes..."
                value={iconEmoji}
                onChange={(e) => setIconEmoji(e.target.value.slice(0, 2))}
                maxLength={2}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
              />
            </div>

            {/* Visibility */}
            <div>
              <label htmlFor="brief-document-visibility" className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
                Visibility
              </label>
              <select
                id="brief-document-visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as DocumentVisibility)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
              >
                {VISIBILITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Project selector */}
            {!isEditMode && (
              <div>
                <label htmlFor="brief-document-project" className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
                  Project (optional)
                </label>
                <select
                  id="brief-document-project"
                  value={projectId || '__none__'}
                  onChange={(e) => setProjectId(e.target.value === '__none__' ? '' : e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
                >
                  <option value="__none__">Organization-wide (no project)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            {isEditMode && existing?.project_name && (
              <div>
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Project</span>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{existing.project_name}</p>
              </div>
            )}

            {/* Template selector (new documents only) */}
            {!isEditMode && templates && templates.length > 0 && (
              <div>
                <label htmlFor="brief-document-template" className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
                  Start from template
                </label>
                <select
                  id="brief-document-template"
                  value={selectedTemplateId || '__none__'}
                  onChange={(e) => setSelectedTemplateId(e.target.value === '__none__' ? '' : e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
                >
                  <option value="__none__">Blank document</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.icon ? `${t.icon} ` : ''}{t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
