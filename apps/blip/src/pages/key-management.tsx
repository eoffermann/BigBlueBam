import { useState } from 'react';
import { KeyRound, Loader2, Plus, Check, Copy, Ban, PauseCircle, PlayCircle } from 'lucide-react';
import {
  useKeys,
  useCreateKey,
  useSuspendKey,
  useRevokeKey,
  type IngestKey,
  type IngestKeyCreated,
  type KeyStatus,
} from '@/hooks/use-blip';
import { ClientSnippets } from '@/components/client-snippets';
import { cn, formatRelativeTime } from '@/lib/utils';

interface KeyManagementPageProps {
  appId: string;
}

const STATUS_STYLE: Record<KeyStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  revoked: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function ingestUrl(): string {
  return `${window.location.origin}/blip/ingest/v1`;
}

// Mirror of RevealOnceSecret (apps/frontend people/reveal-once-secret) — the
// minted token is shown exactly once.
function RevealOnceToken({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200">
        This token is shown only once. Copy it now — embed it in your client.
      </div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-900 dark:text-zinc-100 break-all">
          {token}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function KeyManagementPage({ appId }: KeyManagementPageProps) {
  const { data, isLoading } = useKeys(appId);
  const create = useCreateKey(appId);
  const suspend = useSuspendKey(appId);
  const revoke = useRevokeKey(appId);

  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState<IngestKeyCreated | null>(null);

  const keys = data?.data ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <KeyRound className="h-6 w-6 text-primary-500" />
          Ingest keys
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Write-only credentials embedded in your client. Assumed to leak: each is independently
          suspendable and revocable, and can only append entries to this one app.
        </p>
      </div>

      {/* Create */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            { label: label.trim() || undefined },
            {
              onSuccess: (res) => {
                setMinted(res.data);
                setLabel('');
              },
            },
          );
        }}
        className="flex items-end gap-2"
      >
        <div className="flex flex-col">
          <label className="text-xs text-zinc-500 mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="iOS prod"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={create.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Mint key
        </button>
      </form>

      {/* One-time token + client snippet (§18.3) */}
      {minted && (
        <div className="rounded-xl border border-primary-200 dark:border-primary-900/50 bg-primary-50/40 dark:bg-primary-900/10 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">
              New key {minted.label ? `“${minted.label}”` : ''} created
            </h2>
            <button
              onClick={() => setMinted(null)}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Dismiss
            </button>
          </div>
          <RevealOnceToken token={minted.token} />
          <div>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-2">
              Ready-to-paste client wiring — the ingest URL and this token are already interpolated:
            </p>
            <ClientSnippets ingestUrl={ingestUrl()} token={minted.token} />
          </div>
        </div>
      )}

      {/* Key list */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Key id</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last used</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  Loading…
                </td>
              </tr>
            ) : keys.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  No keys yet. Mint one to start ingesting.
                </td>
              </tr>
            ) : (
              keys.map((k: IngestKey) => (
                <tr key={k.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">{k.label || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                    blip_{k.key_id}_…{k.last4}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize',
                        STATUS_STYLE[k.status],
                      )}
                    >
                      {k.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {k.last_used_at ? formatRelativeTime(k.last_used_at) : 'never'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {k.status !== 'revoked' && (
                        <button
                          onClick={() =>
                            suspend.mutate({ id: k.id, suspend: k.status === 'active' })
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                        >
                          {k.status === 'active' ? (
                            <>
                              <PauseCircle className="h-3.5 w-3.5" /> Suspend
                            </>
                          ) : (
                            <>
                              <PlayCircle className="h-3.5 w-3.5" /> Resume
                            </>
                          )}
                        </button>
                      )}
                      {k.status !== 'revoked' && (
                        <button
                          onClick={() => {
                            if (confirm(`Revoke key ${k.label || k.key_id}? This is permanent.`)) {
                              revoke.mutate(k.id);
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-900/50 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          <Ban className="h-3.5 w-3.5" /> Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
