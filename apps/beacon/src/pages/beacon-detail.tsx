import { Loader2, Edit2, ChevronDown, ExternalLink, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useBeacon, useBeaconLinks, useBeaconVersions } from '@/hooks/use-beacons';
import { StatusBadge } from '@/components/beacon/status-badge';
import { FreshnessIndicator } from '@/components/beacon/freshness-indicator';
import { LifecycleActions } from '@/components/beacon/lifecycle-actions';
import { CommentsSection } from '@/components/beacon/comments-section';
import { AttachmentsPanel } from '@/components/beacon/attachments-panel';
import { Button } from '@/components/common/button';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { useProjectName } from '@/hooks/use-projects';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface BeaconDetailPageProps {
  idOrSlug: string;
  onNavigate: (path: string) => void;
}

export function BeaconDetailPage({ idOrSlug, onNavigate }: BeaconDetailPageProps) {
  const { data: beacon, isLoading, refetch } = useBeacon(idOrSlug);
  const { data: links } = useBeaconLinks(beacon?.id);
  const { data: versions } = useBeaconVersions(beacon?.id);
  const [showVersions, setShowVersions] = useState(false);
  const projectName = useProjectName(beacon?.project_id);
  const displayProjectName = beacon?.project_name ?? projectName ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!beacon) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <p>Beacon not found.</p>
      </div>
    );
  }

  const bodyHtml = sanitizeHtml(markdownToHtml(beacon.body_markdown));

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main area (left ~70%) */}
      <div className="flex-1 overflow-auto p-6 lg:p-8 min-w-0">
        {/* Title + status + actions row */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 truncate">
                {beacon.title}
              </h1>
              <StatusBadge status={beacon.status} />
            </div>
            <LifecycleActions beaconId={beacon.id} status={beacon.status} onSuccess={() => refetch()} />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <PresenceChipStrip
              url={`${window.location.origin}${window.location.pathname}`}
              surfaceApp="beacon"
              surfaceId={beacon.slug ?? beacon.id}
              surfaceLabel={beacon.title}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onNavigate(`/${idOrSlug}/edit`)}
            >
              <Edit2 className="h-4 w-4" />
              Edit
            </Button>
          </div>
        </div>

        {/* Summary */}
        {beacon.summary && (
          <p className="text-zinc-600 dark:text-zinc-400 mb-6 text-sm leading-relaxed">
            {beacon.summary}
          </p>
        )}

        {/* Body */}
        <article
          className="prose prose-zinc dark:prose-invert max-w-none text-sm leading-relaxed [&_.rich-text-code-block]:bg-zinc-100 [&_.rich-text-code-block]:dark:bg-zinc-800 [&_.rich-text-code-block]:p-3 [&_.rich-text-code-block]:rounded-lg [&_.rich-text-code-block]:overflow-x-auto [&_.rich-text-inline-code]:bg-zinc-100 [&_.rich-text-inline-code]:dark:bg-zinc-800 [&_.rich-text-inline-code]:px-1.5 [&_.rich-text-inline-code]:py-0.5 [&_.rich-text-inline-code]:rounded [&_.rich-text-link]:text-primary-600 [&_.rich-text-link]:hover:underline [&_.rich-text-heading]:font-semibold [&_.rich-text-heading]:mt-4 [&_.rich-text-heading]:mb-2 [&_.rich-text-list]:list-disc [&_.rich-text-list]:pl-5 [&_.rich-text-list]:space-y-1"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />

        {/* Tags */}
        {beacon.tags && beacon.tags.length > 0 && (
          <div className="flex items-center gap-2 mt-8 pt-6 border-t border-zinc-200 dark:border-zinc-800 flex-wrap">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Tags:</span>
            {beacon.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-600 dark:text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Attachments */}
        <AttachmentsPanel beaconId={beacon.id} />

        {/* Comments */}
        <CommentsSection beaconId={beacon.id} />
      </div>

      {/* Sidebar (right ~30%) */}
      <aside className="w-80 shrink-0 border-l border-zinc-200 dark:border-zinc-800 overflow-auto p-5 hidden lg:block">
        <div className="space-y-5">
          {/* Status */}
          <SidebarField label="Status">
            <StatusBadge status={beacon.status} />
          </SidebarField>

          {/* Owner */}
          <SidebarField label="Owner">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {beacon.owner_name ?? 'Unknown'}
            </span>
          </SidebarField>

          {/* Project */}
          <SidebarField label="Project">
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {displayProjectName ?? 'Organization-wide'}
              </span>
            </div>
          </SidebarField>

          {/* Freshness */}
          <SidebarField label="Freshness">
            <FreshnessIndicator
              lastVerifiedAt={beacon.last_verified_at}
              expiresAt={beacon.expires_at}
            />
          </SidebarField>

          {/* Expiry countdown */}
          {beacon.expires_at && (
            <SidebarField label="Expires">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {formatDate(beacon.expires_at)}
              </span>
            </SidebarField>
          )}

          {/* Last verified */}
          <SidebarField label="Last Verified">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {beacon.last_verified_at ? formatRelativeTime(beacon.last_verified_at) : 'Never'}
            </span>
          </SidebarField>

          {/* Verification count */}
          <SidebarField label="Verifications">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {beacon.verification_count}
            </span>
          </SidebarField>

          {/* Tags */}
          {beacon.tags && beacon.tags.length > 0 && (
            <SidebarField label="Tags">
              <div className="flex flex-wrap gap-1">
                {beacon.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-600 dark:text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </SidebarField>
          )}

          {/* Linked beacons */}
          {links && links.length > 0 && (
            <SidebarField label="Linked Beacons">
              <div className="space-y-1.5">
                {links.map((link) => (
                  <button
                    key={link.id}
                    onClick={() => onNavigate(`/${link.target_slug ?? link.target_id}`)}
                    className="flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 hover:underline dark:text-primary-400"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{link.target_title}</span>
                  </button>
                ))}
              </div>
            </SidebarField>
          )}

          {/* Version history */}
          <SidebarField label="Version">
            <div>
              <button
                onClick={() => setShowVersions(!showVersions)}
                className="flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:text-primary-600"
              >
                v{beacon.version}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showVersions ? 'rotate-180' : ''}`} />
              </button>
              {showVersions && versions && versions.length > 0 && (
                <div className="mt-2 space-y-1.5 max-h-48 overflow-auto">
                  {versions.map((v) => (
                    <div key={v.id} className="text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-medium">v{v.version}</span>
                      {' '}&mdash;{' '}
                      {v.changed_by_name ?? 'Unknown'}
                      {' '}&middot;{' '}
                      {formatRelativeTime(v.created_at)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SidebarField>

          {/* View in Graph button */}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => onNavigate(`/graph/${beacon.id}`)}
          >
            View in Graph
          </Button>
        </div>
      </aside>
    </div>
  );
}

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
