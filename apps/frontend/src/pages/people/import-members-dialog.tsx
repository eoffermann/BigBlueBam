import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, FileWarning } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Dialog } from '@/components/common/dialog';
import { parseCsv } from '@/lib/csv';
import { peopleApi, type PersonListItem } from '@/lib/api/people';

export type ImportFormat = 'slack' | 'google' | 'generic';

interface FormatDef {
  label: string;
  blurb: string;
  /** Header names (any of) that hold the email address. */
  emailHeaders: string[];
  /** Header names (any of) that hold a ready-made display name. */
  nameHeaders: string[];
  /** Fallback: separate first/last-name columns joined into a display name. */
  firstHeaders?: string[];
  lastHeaders?: string[];
  /** Optional status column + a predicate for rows to skip (deactivated, bots…). */
  statusHeaders?: string[];
  skipStatus?: (status: string) => boolean;
}

export const IMPORT_FORMATS: Record<ImportFormat, FormatDef> = {
  slack: {
    label: 'Slack',
    blurb:
      "Use Slack's member export CSV (Workspace admin → Settings → Import/Export Data). " +
      'Expected columns: username, email, status, billing-active, has-2fa, has-sso, userid, fullname, displayname, expiration-timestamp. ' +
      'Deactivated members and bots are skipped automatically.',
    emailHeaders: ['email'],
    nameHeaders: ['fullname', 'displayname', 'username'],
    statusHeaders: ['status'],
    // Slack status is e.g. "Member", "Admin", "Owner", "Deactivated", "Bot".
    skipStatus: (s) => /deactivat|deleted|\bbot\b/i.test(s),
  },
  google: {
    label: 'Google Workspace',
    blurb:
      'Use the Google Admin console user export CSV. It maps the "Email Address" column plus ' +
      '"First Name" / "Last Name". Suspended accounts are skipped.',
    emailHeaders: ['email address', 'email'],
    nameHeaders: ['display name'],
    firstHeaders: ['first name', 'given name'],
    lastHeaders: ['last name', 'family name'],
    statusHeaders: ['new status', 'status'],
    skipStatus: (s) => /suspend|archiv/i.test(s),
  },
  generic: {
    label: 'CSV',
    blurb:
      'Any CSV with an email column. We auto-detect the email column plus a name column ' +
      '("name", "full name", "display name", or separate "first name" / "last name").',
    emailHeaders: ['email', 'email address', 'e mail', 'mail', 'user email'],
    nameHeaders: ['display name', 'displayname', 'full name', 'fullname', 'name'],
    firstHeaders: ['first name', 'firstname', 'given name'],
    lastHeaders: ['last name', 'lastname', 'surname', 'family name'],
  },
};

type ImportRole = 'member' | 'admin';

interface ParsedRow {
  email: string;
  display_name?: string;
}
interface SkippedRow {
  label: string;
  reason: string;
}
interface ParseOutcome {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  error?: string;
}

/** lowercase, drop bracketed annotations like "[Required]", non-alnum → space. */
function normHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findCol(headers: string[], candidates: string[]): number {
  const cands = candidates.map(normHeader);
  // Exact match wins over a substring match.
  for (const cand of cands) {
    const exact = headers.indexOf(cand);
    if (exact >= 0) return exact;
  }
  for (let i = 0; i < headers.length; i++) {
    if (cands.some((c) => c && headers[i]!.includes(c))) return i;
  }
  return -1;
}

/** Exported for unit tests: parse CSV text against a named source format. */
export function parseImportMembers(text: string, format: ImportFormat): ParseOutcome {
  return parseMembers(text, IMPORT_FORMATS[format]);
}

function parseMembers(text: string, fmt: FormatDef): ParseOutcome {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length < 2) {
    return { rows: [], skipped: [], error: 'No data rows found — the file needs a header row plus at least one person.' };
  }
  const headers = grid[0]!.map(normHeader);
  const emailIdx = findCol(headers, fmt.emailHeaders);
  if (emailIdx < 0) {
    return {
      rows: [],
      skipped: [],
      error: `Couldn't find an email column. Expected one named like: ${fmt.emailHeaders.join(', ')}.`,
    };
  }
  const nameIdx = findCol(headers, fmt.nameHeaders);
  const firstIdx = fmt.firstHeaders ? findCol(headers, fmt.firstHeaders) : -1;
  const lastIdx = fmt.lastHeaders ? findCol(headers, fmt.lastHeaders) : -1;
  const statusIdx = fmt.statusHeaders ? findCol(headers, fmt.statusHeaders) : -1;

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();

  for (const r of grid.slice(1)) {
    const email = (r[emailIdx] ?? '').trim();
    let name = nameIdx >= 0 ? (r[nameIdx] ?? '').trim() : '';
    if (!name && (firstIdx >= 0 || lastIdx >= 0)) {
      name = [firstIdx >= 0 ? r[firstIdx] : '', lastIdx >= 0 ? r[lastIdx] : '']
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' ');
    }
    const display = name || email || '(empty row)';

    if (!email || !email.includes('@')) {
      skipped.push({ label: display, reason: 'no email address' });
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ label: email, reason: 'duplicate in file' });
      continue;
    }
    if (statusIdx >= 0 && fmt.skipStatus) {
      const status = (r[statusIdx] ?? '').trim();
      if (status && fmt.skipStatus(status)) {
        skipped.push({ label: email, reason: `status: ${status}` });
        continue;
      }
    }
    seen.add(key);
    rows.push({ email, display_name: name || undefined });
  }
  return { rows, skipped };
}

const CHUNK = 100; // backend caps /org/members/invite/bulk at 100 per request

type AggResult = {
  succeeded: Array<PersonListItem & { was_existing: boolean }>;
  failed: Array<{ email: string; code: string; message: string }>;
  total_requested: number;
  total_succeeded: number;
  total_failed: number;
};

interface ImportMembersDialogProps {
  open: boolean;
  format: ImportFormat;
  onOpenChange: (open: boolean) => void;
}

export function ImportMembersDialog({ open, format, onOpenChange }: ImportMembersDialogProps) {
  const queryClient = useQueryClient();
  const fmt = IMPORT_FORMATS[format];

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [role, setRole] = useState<ImportRole>('member');
  const [showAllSkipped, setShowAllSkipped] = useState(false);
  const [result, setResult] = useState<AggResult | null>(null);

  const parsed = useMemo<ParseOutcome>(
    () => (text.trim() ? parseMembers(text, fmt) : { rows: [], skipped: [] }),
    [text, fmt],
  );

  const importMut = useMutation({
    mutationFn: async (rows: ParsedRow[]): Promise<AggResult> => {
      const agg: AggResult = {
        succeeded: [],
        failed: [],
        total_requested: 0,
        total_succeeded: 0,
        total_failed: 0,
      };
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK).map((r) => ({
          email: r.email,
          role,
          ...(r.display_name ? { display_name: r.display_name } : {}),
        }));
        const res = await peopleApi.bulkInviteMembers(chunk);
        agg.succeeded.push(...res.data.succeeded);
        agg.failed.push(...res.data.failed);
        agg.total_requested += res.data.total_requested;
        agg.total_succeeded += res.data.total_succeeded;
        agg.total_failed += res.data.total_failed;
      }
      return agg;
    },
    onSuccess: (res) => {
      setResult(res);
      queryClient.invalidateQueries({ queryKey: ['people'] });
      queryClient.invalidateQueries({ queryKey: ['org-summary'] });
    },
  });

  function reset() {
    setText('');
    setFileName(null);
    setRole('member');
    setShowAllSkipped(false);
    setResult(null);
    importMut.reset();
  }
  function close() {
    onOpenChange(false);
    window.setTimeout(reset, 200);
  }

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  }

  const skippedToShow = showAllSkipped ? parsed.skipped : parsed.skipped.slice(0, 5);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={result ? 'Import results' : `Import people from ${fmt.label}`}
      description={
        result
          ? `${result.total_succeeded} of ${result.total_requested} imported`
          : fmt.blurb
      }
      className="max-w-3xl"
    >
      {result ? (
        <div className="space-y-4">
          {result.succeeded.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-green-700 dark:text-green-300 mb-2">
                Imported ({result.succeeded.length})
              </h3>
              <ul className="max-h-56 overflow-auto rounded-md border border-green-200 dark:border-green-900 divide-y divide-green-200 dark:divide-green-900">
                {result.succeeded.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between px-3 py-2 bg-green-50/60 dark:bg-green-950/40 text-sm"
                  >
                    <span className="text-zinc-900 dark:text-zinc-100">{s.display_name || s.email}</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {s.email}
                      {s.was_existing ? ' · existing user, added to org' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {result.failed.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-red-700 dark:text-red-300 mb-2">
                Couldn't import ({result.failed.length})
              </h3>
              <ul className="max-h-40 overflow-auto rounded-md border border-red-200 dark:border-red-900 divide-y divide-red-200 dark:divide-red-900">
                {result.failed.map((f, idx) => (
                  <li
                    key={`${f.email}-${idx}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 bg-red-50/60 dark:bg-red-950/40 text-sm"
                  >
                    <span className="text-zinc-900 dark:text-zinc-100 truncate">{f.email}</span>
                    <span className="text-xs text-red-700 dark:text-red-300 text-right">{f.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={reset}>
              Import another file
            </Button>
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* File picker / drop zone */}
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files?.[0]);
            }}
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 px-4 py-6 text-center cursor-pointer hover:border-primary-400 dark:hover:border-primary-600 transition-colors"
          >
            <Upload className="h-5 w-5 text-zinc-400" />
            <span className="text-sm text-zinc-600 dark:text-zinc-300">
              {fileName ? <span className="font-medium">{fileName}</span> : 'Drop a CSV here, or click to choose a file'}
            </span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
          </label>

          <details>
            <summary className="text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer select-none">
              …or paste CSV content
            </summary>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
              }}
              rows={4}
              placeholder="email,fullname&#10;jane@acme.com,Jane Doe"
              className="mt-2 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-2 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </details>

          {/* Parse feedback */}
          {text.trim() && parsed.error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              <FileWarning className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{parsed.error}</span>
            </div>
          )}

          {text.trim() && !parsed.error && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm text-zinc-600 dark:text-zinc-300">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {parsed.rows.length}
                  </span>{' '}
                  {parsed.rows.length === 1 ? 'person' : 'people'} ready to import
                  {parsed.skipped.length > 0 && (
                    <span className="text-zinc-400"> · {parsed.skipped.length} skipped</span>
                  )}
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-zinc-500">Role</span>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as ImportRole)}
                    className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
              </div>

              {parsed.rows.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800/80 text-left text-xs text-zinc-500">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">Email</th>
                        <th className="px-3 py-1.5 font-medium">Name</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {parsed.rows.map((r) => (
                        <tr key={r.email}>
                          <td className="px-3 py-1.5 text-zinc-800 dark:text-zinc-200">{r.email}</td>
                          <td className="px-3 py-1.5 text-zinc-500">{r.display_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {parsed.skipped.length > 0 && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium">Skipped:</span>{' '}
                  {skippedToShow.map((s, i) => (
                    <span key={`${s.label}-${i}`}>
                      {i > 0 && ', '}
                      {s.label} ({s.reason})
                    </span>
                  ))}
                  {parsed.skipped.length > 5 && !showAllSkipped && (
                    <button
                      type="button"
                      onClick={() => setShowAllSkipped(true)}
                      className="ml-1 underline hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      +{parsed.skipped.length - 5} more
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {importMut.isError && (
            <p className="text-sm text-red-600">
              {(importMut.error as Error)?.message ?? 'Import failed.'}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={() => importMut.mutate(parsed.rows)}
              loading={importMut.isPending}
              disabled={parsed.rows.length === 0 || !!parsed.error}
            >
              {parsed.rows.length > 0
                ? `Import ${parsed.rows.length} ${parsed.rows.length === 1 ? 'person' : 'people'}`
                : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
