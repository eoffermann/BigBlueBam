/**
 * SuperUser Console -> Backups tab (Backup app, Platform scope).
 *
 * Whole-database pg_dump backups: list, trigger a backup now, download the
 * archive, delete, and restore. Restore is destructive and requires the operator
 * to type the exact per-backup confirmation phrase.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  Download,
  Trash2,
  RotateCcw,
  Loader2,
  Play,
  AlertTriangle,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';

interface BackupRow {
  id: string;
  kind: string;
  status: string;
  size_bytes: number | null;
  pg_version: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  restore_confirmation: string;
}

interface RestoreRow {
  id: string;
  backup_id: string | null;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface BackupsResponse {
  data: { backups: BackupRow[]; restores: RestoreRow[] };
}

function formatBytes(n: number | null): string {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {(status === 'running' || status === 'pending') && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
    </span>
  );
}

export function SuperuserBackupsTab() {
  const qc = useQueryClient();
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);

  const query = useQuery({
    queryKey: ['superuser', 'backups'],
    queryFn: () => api.get<BackupsResponse>('/superuser/backups'),
    // Poll while anything is in flight so the UI reflects job progress.
    refetchInterval: (q) => {
      const d = q.state.data?.data;
      const active =
        d?.backups.some((b) => b.status === 'pending' || b.status === 'running') ||
        d?.restores.some((r) => r.status === 'pending' || r.status === 'running');
      return active ? 3000 : false;
    },
  });

  const backupNow = useMutation({
    mutationFn: () => api.post('/superuser/backups'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['superuser', 'backups'] }),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/superuser/backups/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['superuser', 'backups'] }),
  });

  const backups = query.data?.data.backups ?? [];
  const restores = query.data?.data.restores ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Database className="h-4.5 w-4.5" /> Database Backups
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Whole-database snapshots (pg_dump). A backup runs automatically each night; you can also
            trigger one now, download an archive to keep offsite, or restore.
          </p>
        </div>
        <button
          type="button"
          onClick={() => backupNow.mutate()}
          disabled={backupNow.isPending}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium disabled:opacity-60"
        >
          {backupNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Back up now
        </button>
      </div>

      {query.isLoading ? (
        <div className="flex items-center justify-center py-12 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : backups.length === 0 ? (
        <div className="text-center py-12 text-sm text-zinc-500 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg">
          No backups yet. Click <span className="font-medium">Back up now</span> to create the first one.
        </div>
      ) : (
        <div className="overflow-x-auto border border-zinc-200 dark:border-zinc-800 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Created</th>
                <th className="text-left font-medium px-4 py-2">Type</th>
                <th className="text-left font-medium px-4 py-2">Status</th>
                <th className="text-left font-medium px-4 py-2">Size</th>
                <th className="text-left font-medium px-4 py-2">PG</th>
                <th className="text-right font-medium px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {backups.map((b) => (
                <tr key={b.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                    {new Date(b.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-zinc-500 capitalize">{b.kind}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={b.status} />
                    {b.error && <div className="text-xs text-red-500 mt-1 max-w-xs truncate" title={b.error}>{b.error}</div>}
                  </td>
                  <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">{formatBytes(b.size_bytes)}</td>
                  <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">{b.pg_version ?? '-'}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {b.status === 'completed' && (
                        <>
                          <a
                            href={`/b3/api/superuser/backups/${b.id}/download`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="Download archive"
                          >
                            <Download className="h-3.5 w-3.5" /> Download
                          </a>
                          <button
                            type="button"
                            onClick={() => setRestoreTarget(b)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                            title="Restore this backup (destructive)"
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Restore
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm('Delete this backup archive? This cannot be undone.')) del.mutate(b.id);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                        title="Delete backup"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {restores.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Restore history</h3>
          <div className="overflow-x-auto border border-zinc-200 dark:border-zinc-800 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Requested</th>
                  <th className="text-left font-medium px-4 py-2">Status</th>
                  <th className="text-left font-medium px-4 py-2">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {restores.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={r.status} />
                      {r.error && <div className="text-xs text-red-500 mt-1 max-w-xs truncate" title={r.error}>{r.error}</div>}
                    </td>
                    <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">
                      {r.completed_at ? new Date(r.completed_at).toLocaleString() : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {restoreTarget && (
        <RestoreModal
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onDone={() => {
            setRestoreTarget(null);
            qc.invalidateQueries({ queryKey: ['superuser', 'backups'] });
          }}
        />
      )}
    </div>
  );
}

function RestoreModal({
  backup,
  onClose,
  onDone,
}: {
  backup: BackupRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [phrase, setPhrase] = useState('');
  const matches = phrase.trim() === backup.restore_confirmation;

  const restore = useMutation({
    mutationFn: () =>
      api.post(`/superuser/backups/${backup.id}/restore`, { confirmation_phrase: phrase.trim() }),
    onSuccess: () => onDone(),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 shadow-xl border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <h3 className="text-base font-semibold text-red-600 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" /> Restore database
          </h3>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <p className="text-zinc-700 dark:text-zinc-300">
            This will <span className="font-semibold text-red-600">overwrite the entire database</span> with the
            snapshot from <span className="font-medium">{new Date(backup.created_at).toLocaleString()}</span>.
            Everything currently in the database - all orgs, users, and app data - is replaced. This cannot be undone.
          </p>
          <p className="text-zinc-500 text-xs">
            Run this during a maintenance window: connected users and in-flight work will be disrupted while the
            restore runs.
          </p>
          <div>
            <label htmlFor="restore-phrase" className="block text-xs text-zinc-500 mb-1">
              Type <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-200">{backup.restore_confirmation}</span> to confirm
            </label>
            <input
              id="restore-phrase"
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
              placeholder={backup.restore_confirmation}
            />
          </div>
          {restore.isError && (
            <p className="text-xs text-red-500">
              {(restore.error as Error)?.message ?? 'Restore failed to start.'}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-100 dark:border-zinc-800">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => restore.mutate()}
            disabled={!matches || restore.isPending}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {restore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Restore database
          </button>
        </div>
      </div>
    </div>
  );
}
