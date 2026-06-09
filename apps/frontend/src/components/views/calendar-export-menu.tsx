/**
 * Export dropdown for the Calendar view.
 *
 *   - Download .ics: pulls the authenticated /projects/:id/calendar.ics
 *     endpoint and downloads it as a one-shot file.
 *   - Get sharable link: mints (or surfaces) a public iCal token for
 *     this project. The link is openable as a `webcal://` subscription
 *     in Calendar.app / Google Calendar / Outlook, OR as a plain
 *     https URL for any tool that prefers polling. Tokens are
 *     revokable from the same modal.
 *
 * The shareable-link UX lives in a small modal rather than a submenu
 * because users need to copy the URL, see the token name, and revoke —
 * a dropdown row alone isn't enough.
 */
import { useState, useRef, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  ChevronDown,
  CalendarPlus,
  Link2,
  Loader2,
  Copy,
  Check,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/common/button';
import { cn } from '@/lib/utils';

interface CalendarToken {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface MintTokenResponse {
  id: string;
  name: string;
  token: string;
  token_prefix: string;
  ics_url: string;
  webcal_url: string;
  created_at: string;
}

interface CalendarExportMenuProps {
  projectId: string;
  projectName: string;
}

export function CalendarExportMenu({ projectId, projectName }: CalendarExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function downloadIcs() {
    // The .ics endpoint sits under the same /v1/ prefix so the standard
    // api client picks up cookies automatically. We fetch as text to
    // sidestep the api client's JSON-parsing default.
    setOpen(false);
    const url = `/b3/api/projects/${projectId}/calendar.ics`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      alert('Could not fetch calendar — please try again.');
      return;
    }
    const body = await res.text();
    const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    const blob = new Blob([body], { type: 'text/calendar;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${slug}-${new Date().toISOString().split('T')[0]}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
        >
          <Download className="h-3.5 w-3.5" />
          Export
          <ChevronDown className="h-3 w-3 text-zinc-400" />
        </button>
        {open && (
          <div className="absolute right-0 mt-1 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl z-50 py-1 text-sm">
            <button
              onClick={() => void downloadIcs()}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              Download .ics (one-time)
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setShowLinkModal(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <Link2 className="h-3.5 w-3.5" />
              Get sharable subscription link…
            </button>
          </div>
        )}
      </div>

      {showLinkModal && (
        <CalendarLinkModal
          projectId={projectId}
          projectName={projectName}
          onClose={() => setShowLinkModal(false)}
        />
      )}
    </>
  );
}

function CalendarLinkModal({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [newTokenSecret, setNewTokenSecret] = useState<MintTokenResponse | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const tokensQuery = useQuery({
    queryKey: ['project-calendar-tokens', projectId],
    queryFn: () =>
      api.get<{ data: CalendarToken[] }>(`/projects/${projectId}/calendar-tokens`),
  });

  const mintMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<{ data: MintTokenResponse }>(
        `/projects/${projectId}/calendar-tokens`,
        { name },
      ),
    onSuccess: (res) => {
      setNewTokenSecret(res.data);
      queryClient.invalidateQueries({ queryKey: ['project-calendar-tokens', projectId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) =>
      api.delete(`/projects/${projectId}/calendar-tokens/${tokenId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-calendar-tokens', projectId] });
    },
  });

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedUrl(text);
      setTimeout(() => setCopiedUrl(null), 1500);
    });
  }

  const tokens = tokensQuery.data?.data ?? [];
  const activeTokens = tokens.filter((t) => !t.revoked_at);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Calendar subscription links
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Share a public iCal URL to {projectName}. The recipient can subscribe in
              Google Calendar, Apple Calendar, or Outlook and it stays up to date.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Newly-minted token banner (only shown once) */}
        {newTokenSecret && (
          <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-900 p-3 mb-4 space-y-2">
            <div className="text-xs font-medium text-green-800 dark:text-green-300">
              New token created. Copy these URLs now — the secret won't be shown again.
            </div>
            <LinkRow
              label="HTTPS feed"
              url={`${window.location.origin}${newTokenSecret.ics_url}`}
              copied={copiedUrl === `${window.location.origin}${newTokenSecret.ics_url}`}
              onCopy={() => copy(`${window.location.origin}${newTokenSecret.ics_url}`)}
            />
            <LinkRow
              label="webcal:// (auto-subscribe)"
              url={newTokenSecret.webcal_url.replace('__HOST__', window.location.host)}
              copied={
                copiedUrl ===
                newTokenSecret.webcal_url.replace('__HOST__', window.location.host)
              }
              onCopy={() =>
                copy(newTokenSecret.webcal_url.replace('__HOST__', window.location.host))
              }
            />
          </div>
        )}

        {/* Mint button */}
        <div className="flex items-center gap-2 mb-4">
          <Button
            size="sm"
            onClick={() => mintMutation.mutate(`Public schedule ${activeTokens.length + 1}`)}
            disabled={mintMutation.isPending}
          >
            {mintMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Link2 className="h-3.5 w-3.5" />
                Generate new link
              </>
            )}
          </Button>
          <p className="text-xs text-zinc-500">
            Anyone with the link can read the schedule, even without a Bam account.
          </p>
        </div>

        {/* Existing tokens list */}
        <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3">
          <h3 className="text-xs font-medium text-zinc-500 mb-2">Active links</h3>
          {tokensQuery.isLoading ? (
            <div className="text-xs text-zinc-400">Loading…</div>
          ) : activeTokens.length === 0 ? (
            <div className="text-xs text-zinc-400 italic">
              No public links yet. Generate one above to share the schedule.
            </div>
          ) : (
            <div className="space-y-2">
              {activeTokens.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-2 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-zinc-700 dark:text-zinc-300 truncate">
                      {t.name}
                    </div>
                    <div className="text-zinc-400 mt-0.5">
                      <span className="font-mono">{t.token_prefix}…</span>
                      {t.last_used_at ? (
                        <> · last used {new Date(t.last_used_at).toLocaleDateString()}</>
                      ) : (
                        <> · never used</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (window.confirm(`Revoke "${t.name}"? Subscribers will stop receiving updates.`)) {
                        revokeMutation.mutate(t.id);
                      }
                    }}
                    className="rounded-md p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                    title="Revoke this link"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkRow({
  label,
  url,
  copied,
  onCopy,
}: {
  label: string;
  url: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-green-700 dark:text-green-400 shrink-0 w-32">
        {label}
      </span>
      <code className="flex-1 bg-white dark:bg-zinc-950 px-2 py-1 rounded border border-green-300 dark:border-green-800 text-[10px] text-zinc-700 dark:text-zinc-200 truncate">
        {url}
      </code>
      <button
        onClick={onCopy}
        className={cn(
          'shrink-0 rounded-md p-1.5 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
          copied && 'text-green-600',
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
