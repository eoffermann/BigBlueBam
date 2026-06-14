import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Hash, Lock, Check, AlertCircle, Loader2 } from 'lucide-react';
import {
  useBulkCreateChannels,
  type BulkChannelInput,
  type BulkChannelResult,
} from '@/hooks/use-channels';
import { cn } from '@/lib/utils';

interface BulkCreateChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Navigate to a channel after the batch lands (e.g. the first created). */
  onNavigate?: (path: string) => void;
}

/** Channel-name rules mirror the API (apps/banter-api channel.routes.ts). */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME_LEN = 80;
const MAX_ROWS = 50;

/** One parsed line, with its slug and a client-side validity verdict. */
interface ParsedLine {
  /** The slugified name we will actually send + key on. */
  slug: string;
  /** The raw text the user typed (for echoing back in error rows). */
  raw: string;
  valid: boolean;
  reason?: string;
  /** True when an earlier line already produced this slug. */
  duplicate: boolean;
}

/**
 * Slugify a pasted line the same way the server does: trim, lowercase,
 * collapse whitespace to hyphens. This is intentionally forgiving — it lets
 * an admin paste "Backend Standup" and get `backend-standup` rather than an
 * "invalid" row. Anything still illegal after this (e.g. leading hyphen,
 * punctuation) is flagged client-side before we send.
 */
function slugify(line: string): string {
  return line.trim().toLowerCase().replace(/\s+/g, '-');
}

function parseLines(text: string): ParsedLine[] {
  const seen = new Set<string>();
  const out: ParsedLine[] = [];
  for (const rawLine of text.split('\n')) {
    const raw = rawLine.trim();
    if (!raw) continue; // drop blank lines
    const slug = slugify(raw);
    let valid = true;
    let reason: string | undefined;
    if (slug.length === 0) {
      valid = false;
      reason = 'Empty name';
    } else if (slug.length > MAX_NAME_LEN) {
      valid = false;
      reason = `Too long (max ${MAX_NAME_LEN})`;
    } else if (!NAME_RE.test(slug)) {
      valid = false;
      reason = 'Use lowercase letters, numbers, and hyphens';
    }
    const duplicate = valid && seen.has(slug);
    if (valid && !duplicate) seen.add(slug);
    out.push({ slug, raw, valid, reason, duplicate });
  }
  return out;
}

export function BulkCreateChannelsDialog({ open, onOpenChange, onNavigate }: BulkCreateChannelsDialogProps) {
  const [text, setText] = useState('');
  const [channelType, setChannelType] = useState<'public' | 'private'>('public');
  const [results, setResults] = useState<BulkChannelResult[] | null>(null);
  const bulkCreate = useBulkCreateChannels();

  const parsed = useMemo(() => parseLines(text), [text]);
  const validRows = parsed.filter((p) => p.valid && !p.duplicate);
  const invalidCount = parsed.filter((p) => !p.valid).length;
  const dupCount = parsed.filter((p) => p.duplicate).length;
  const overLimit = validRows.length > MAX_ROWS;

  // Reset transient state whenever the dialog is opened or closed so a second
  // open doesn't show stale results from a previous batch.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setText('');
      setChannelType('public');
      setResults(null);
      bulkCreate.reset();
    }
    onOpenChange(next);
  };

  const handleSubmit = () => {
    if (validRows.length === 0 || overLimit) return;
    const channels: BulkChannelInput[] = validRows.map((r) => ({ name: r.slug }));
    bulkCreate.mutate(
      { channels, type: channelType },
      {
        onSuccess: (res) => {
          setResults(res);
          // Trim the textarea down to the rows that did NOT succeed so the
          // admin can fix + retry just those. Created/duplicate rows are
          // already done; we keep 'invalid' and 'error' rows for another go.
          const keep = new Set(
            res.filter((r) => r.status === 'invalid' || r.status === 'error').map((r) => r.name),
          );
          if (keep.size > 0) {
            setText(
              parsed
                .filter((p) => keep.has(p.slug))
                .map((p) => p.slug)
                .join('\n'),
            );
          } else {
            setText('');
          }
          // Jump to the first newly-created channel so the admin lands
          // somewhere useful, mirroring single-create's navigate-on-success.
          // We keep the dialog open (partial failures may remain to review).
          const firstCreated = res.find((r) => r.status === 'created')?.channel;
          if (firstCreated && onNavigate) {
            onNavigate(`/channels/${firstCreated.slug}`);
          }
        },
      },
    );
  };

  const createdCount = results?.filter((r) => r.status === 'created').length ?? 0;
  const skippedResults = results?.filter((r) => r.status !== 'created') ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl text-zinc-200 focus:outline-none"
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="flex items-start justify-between mb-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-white">Add many channels</Dialog.Title>
              <Dialog.Description className="text-xs text-zinc-500 mt-0.5">
                Paste one channel name per line. Up to {MAX_ROWS} at a time.
              </Dialog.Description>
            </div>
            <Dialog.Close className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (results) setResults(null);
            }}
            rows={8}
            autoFocus
            placeholder={'backend-standup\nproduct-design\nrandom'}
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-primary-500 font-mono"
          />

          {/* Live parse summary + per-line validity hints */}
          <div className="mt-2 flex items-center gap-3 text-xs">
            <span className="text-zinc-400">
              {validRows.length} valid
            </span>
            {dupCount > 0 && <span className="text-yellow-500">{dupCount} duplicate</span>}
            {invalidCount > 0 && <span className="text-red-400">{invalidCount} invalid</span>}
            {overLimit && <span className="text-red-400">Over {MAX_ROWS}-channel limit</span>}
          </div>

          {/* Surface the specific invalid/duplicate lines so the admin can fix
              them before sending. Only shown while there's something wrong. */}
          {(invalidCount > 0 || dupCount > 0) && (
            <ul className="mt-1.5 max-h-24 overflow-y-auto custom-scrollbar space-y-0.5 text-xs">
              {parsed
                .filter((p) => !p.valid || p.duplicate)
                .slice(0, 20)
                .map((p, i) => (
                  <li key={`${p.slug}-${i}`} className="flex items-center gap-1.5 text-zinc-500">
                    <AlertCircle className="h-3 w-3 flex-shrink-0 text-red-400/70" />
                    <span className="font-mono text-zinc-400 truncate">{p.raw}</span>
                    <span className="text-zinc-600">— {p.duplicate ? 'duplicate in list' : p.reason}</span>
                  </li>
                ))}
            </ul>
          )}

          {/* Public / private toggle */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-zinc-500">Visibility</span>
            <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setChannelType('public')}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 text-xs',
                  channelType === 'public' ? 'bg-primary-600 text-white' : 'text-zinc-400 hover:bg-zinc-800',
                )}
              >
                <Hash className="h-3 w-3" /> Public
              </button>
              <button
                type="button"
                onClick={() => setChannelType('private')}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 text-xs',
                  channelType === 'private' ? 'bg-primary-600 text-white' : 'text-zinc-400 hover:bg-zinc-800',
                )}
              >
                <Lock className="h-3 w-3" /> Private
              </button>
            </div>
          </div>

          {/* Results summary after a submit. We deliberately do NOT auto-close
              on partial failure — the admin keeps the dialog to review + retry. */}
          {results && (
            <div className="mt-3 rounded-md border border-zinc-700 bg-zinc-950/60 p-3 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-green-400">
                <Check className="h-3.5 w-3.5" />
                {createdCount} channel{createdCount === 1 ? '' : 's'} created
              </div>
              {skippedResults.length > 0 && (
                <div className="text-zinc-400">
                  {skippedResults.length} skipped:
                  <ul className="mt-1 max-h-28 overflow-y-auto custom-scrollbar space-y-0.5">
                    {skippedResults.map((r, i) => (
                      <li key={`${r.name}-${i}`} className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-block w-14 flex-shrink-0 text-[10px] uppercase tracking-wide',
                            r.status === 'duplicate' ? 'text-yellow-500' : 'text-red-400',
                          )}
                        >
                          {r.status}
                        </span>
                        <span className="font-mono text-zinc-300 truncate">{r.name}</span>
                        {r.error && <span className="text-zinc-600 truncate">— {r.error}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {bulkCreate.isError && (
            <p className="mt-2 text-xs text-red-400">
              Couldn’t submit the batch. {(bulkCreate.error as Error)?.message ?? 'Please try again.'}
            </p>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Dialog.Close className="px-3 py-1.5 text-sm rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800">
              Close
            </Dialog.Close>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={validRows.length === 0 || overLimit || bulkCreate.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {bulkCreate.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {results ? 'Create remaining' : `Create ${validRows.length || ''} channel${validRows.length === 1 ? '' : 's'}`.trim()}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
