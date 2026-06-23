import { useState, useEffect } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';
import {
  useBeacon,
  useCreateBeacon,
  useUpdateBeacon,
  usePublishBeacon,
  type BeaconVisibility,
} from '@/hooks/use-beacons';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { useProjectStore } from '@/stores/project.store';
import { useProjects } from '@/hooks/use-projects';
import { useCollaboration } from '@/hooks/use-collaboration';
import { MarkdownCoeditor } from '@/components/editor/markdown-coeditor';

interface BeaconEditorPageProps {
  idOrSlug?: string;
  onNavigate: (path: string) => void;
}

const VISIBILITY_OPTIONS = [
  { value: 'Public', label: 'Public' },
  { value: 'Organization', label: 'Organization' },
  { value: 'Project', label: 'Project' },
  { value: 'Private', label: 'Private' },
];

export function BeaconEditorPage({ idOrSlug, onNavigate }: BeaconEditorPageProps) {
  const isEditMode = !!idOrSlug;
  const { data: existing, isLoading: loadingExisting } = useBeacon(idOrSlug);
  const createBeacon = useCreateBeacon();
  const updateBeacon = useUpdateBeacon();
  const publishBeacon = usePublishBeacon();
  const { projects } = useProjects();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [projectId, setProjectId] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [visibility, setVisibility] = useState<BeaconVisibility>('Organization');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Set when a save is rejected as stale (someone changed the article since it
  // was opened). While true, the next save omits the guard to force an overwrite.
  const [staleConflict, setStaleConflict] = useState(false);

  // T4 co-editing: when editing an existing article, the body lives in a shared
  // Yjs doc (a Y.Text of the markdown) synced over /beacon/ws. Create mode has
  // no entry id yet, so it stays on the plain textarea + `body` state until the
  // first save mints an id. Hook is called unconditionally (before any early
  // return) to satisfy the rules of hooks; it makes no connection for a null id.
  const { ydoc, provider } = useCollaboration(
    isEditMode && existing ? existing.id : null,
  );

  // The body to persist on save/publish. In edit mode prefer the live Yjs text,
  // but only when it actually has content — before the doc has synced/seeded it
  // is empty, and an early save must not wipe the article. (Content-based rather
  // than isSynced-gated: the provider's sync flag can lag behind a doc that is
  // already populated, which would otherwise drop live edits on save.)
  const getBody = (): string => {
    if (isEditMode && existing) {
      const live = ydoc.getText('body').toString();
      return live.length > 0 ? live : existing.body_markdown ?? '';
    }
    return body;
  };

  // Pre-select the active project from the store when creating
  useEffect(() => {
    if (!isEditMode && activeProjectId && !projectId) {
      setProjectId(activeProjectId);
    }
  }, [isEditMode, activeProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Populate form when editing
  useEffect(() => {
    if (existing) {
      setTitle(existing.title);
      setSummary(existing.summary ?? '');
      setBody(existing.body_markdown ?? '');
      setProjectId(existing.project_id ?? '');
      setTagsInput(existing.tags?.join(', ') ?? '');
      setVisibility(existing.visibility ?? 'Organization');
    }
  }, [existing]);

  if (isEditMode && loadingExisting) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  const parseTags = (): string[] =>
    tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

  const handleSaveDraft = async () => {
    setSaveError(null);
    try {
      if (isEditMode && existing) {
        await updateBeacon.mutateAsync({
          id: existing.id,
          data: {
            title, summary, body_markdown: getBody(), tags: parseTags(), visibility,
            // Stale-write guard: send the updated_at we loaded so the server
            // rejects (409) if it changed under us. After a stale conflict the
            // user can Save again to overwrite, which omits the guard.
            ...(staleConflict ? {} : { expected_updated_at: existing.updated_at }),
          },
        });
        onNavigate(`/${idOrSlug}`);
      } else {
        const res = await createBeacon.mutateAsync({
          title,
          summary,
          body_markdown: getBody(),
          project_id: projectId || undefined,
          tags: parseTags(),
          visibility,
          status: 'Draft',
        });
        onNavigate(`/${res.data.slug ?? res.data.id}`);
      }
    } catch (err: any) {
      if (err?.status === 409 || err?.code === 'STALE_WRITE') {
        setStaleConflict(true);
        setSaveError(
          'This article changed since you opened it. Reload the page to get the latest version, or click Save again to overwrite it with your changes.',
        );
      } else {
        setSaveError(err?.message ?? 'Failed to save');
      }
    }
  };

  const handlePublish = async () => {
    setSaveError(null);
    try {
      if (isEditMode && existing) {
        await updateBeacon.mutateAsync({
          id: existing.id,
          data: { title, summary, body_markdown: getBody(), tags: parseTags(), visibility },
        });
        await publishBeacon.mutateAsync(existing.id);
        onNavigate(`/${idOrSlug}`);
      } else {
        const res = await createBeacon.mutateAsync({
          title,
          summary,
          body_markdown: getBody(),
          project_id: projectId || undefined,
          tags: parseTags(),
          visibility,
          status: 'Active',
        });
        onNavigate(`/${res.data.slug ?? res.data.id}`);
      }
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to publish');
    }
  };

  const isSaving = createBeacon.isPending || updateBeacon.isPending || publishBeacon.isPending;
  const summaryRemaining = 500 - summary.length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate(isEditMode ? `/${idOrSlug}` : '/list')}
            className="rounded-md p-1.5 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {isEditMode ? 'Edit Beacon' : 'Create Beacon'}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleSaveDraft} loading={isSaving} disabled={!title.trim()}>
            Save as Draft
          </Button>
          <Button size="sm" onClick={handlePublish} loading={isSaving} disabled={!title.trim()}>
            Publish
          </Button>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-auto p-6 lg:p-8">
        <div className="max-w-3xl space-y-6">
          {saveError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
              {saveError}
            </div>
          )}

          {/* Title */}
          <div>
            <label htmlFor="beacon-editor-title" className="sr-only">
              Title
            </label>
            <input
              id="beacon-editor-title"
              type="text"
              placeholder="Beacon title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-2xl font-bold bg-transparent border-0 outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
            />
          </div>

          {/* Summary */}
          <div>
            <label htmlFor="beacon-editor-summary" className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
              Summary
            </label>
            <textarea
              id="beacon-editor-summary"
              placeholder="Brief description (max 500 characters)..."
              value={summary}
              onChange={(e) => {
                if (e.target.value.length <= 500) setSummary(e.target.value);
              }}
              rows={3}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-none"
            />
            <p className={`text-xs mt-1 ${summaryRemaining < 50 ? 'text-yellow-600' : 'text-zinc-400'}`}>
              {summaryRemaining} characters remaining
            </p>
          </div>

          {/* Body */}
          <div>
            <label htmlFor="beacon-editor-body" className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
              Body (Markdown)
              {isEditMode && (
                <span className="ml-2 font-normal text-xs text-zinc-400">live co-editing</span>
              )}
            </label>
            {isEditMode && existing ? (
              // T4 collaborative markdown editor bound to the shared Yjs doc.
              <MarkdownCoeditor ydoc={ydoc} provider={provider} editable={true} />
            ) : (
              <textarea
                id="beacon-editor-body"
                placeholder="Write your knowledge article in Markdown..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-y font-mono"
              />
            )}
          </div>

          {/* Project selector */}
          {!isEditMode ? (
            <Select
              label="Project (optional)"
              placeholder="Organization-wide (no project)"
              options={[
                { value: '__none__', label: 'Organization-wide (no project)' },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
              value={projectId || '__none__'}
              onValueChange={(v) => setProjectId(v === '__none__' ? '' : v)}
            />
          ) : existing?.project_name ? (
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Project</span>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{existing.project_name}</p>
            </div>
          ) : existing?.project_id ? (
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Project</span>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                {projects.find((p) => p.id === existing.project_id)?.name ?? existing.project_id}
              </p>
            </div>
          ) : null}

          {/* Tags */}
          <Input
            label="Tags (comma-separated)"
            placeholder="e.g. onboarding, deployment, api"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />

          {/* Visibility */}
          <Select
            label="Visibility"
            options={VISIBILITY_OPTIONS}
            value={visibility}
            onValueChange={(v) => setVisibility(v as BeaconVisibility)}
          />
        </div>
      </div>
    </div>
  );
}
