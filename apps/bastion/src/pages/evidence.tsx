import { useState, type FormEvent } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import type { BastionManualEvidenceCreate } from '@bigbluebam/shared';
import type { EvidenceItem, FeedRow, MintedKey } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth.store';
import {
  useCheckScanAgain,
  useCreateEvidence,
  useCreateFeed,
  useFeedKeys,
  useFeeds,
  useManualEvidence,
  useMintFeedKey,
  useReviewEvidence,
  useRevokeFeedKey,
  useWithdrawEvidence,
} from '@/hooks/use-bastion';
import { expiresText } from '@/pages/readiness';

// Evidence locker (spec 6.1, 3.3, 3.5): uploads, statements, feeds and keys, scan labels, and
// stuck scans with Check again. Floored actions are hidden with useCan (spec 6.3).

const primary = 'px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50';
const secondary =
  'px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50';
const input = 'w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm';

const BLOCKED_WORDS: Record<string, string> = {
  infected: 'Blocked: the virus scan found a problem in this file',
  scan_failed: 'Blocked: the virus scan could not check this file',
  changed_before_scan: 'Blocked: the file changed in Bin before its scan finished. Attach the new version.',
};

export function statusWords(item: Pick<EvidenceItem, 'status' | 'blocked_reason' | 'withdrawn_reason'>): string {
  switch (item.status) {
    case 'pending_scan':
      return 'Waiting for virus scan';
    case 'active':
      return 'In use';
    case 'superseded':
      return 'Replaced by a newer copy';
    case 'withdrawn':
      return item.withdrawn_reason === 'redacted' ? 'Withdrawn (personal data removed)' : 'Withdrawn';
    case 'blocked':
      return BLOCKED_WORDS[item.blocked_reason ?? ''] ?? 'Blocked';
    default:
      return item.status;
  }
}

const VERDICT_WORDS: Record<string, string> = {
  pending: 'Waiting for review',
  accepted: 'Accepted',
  shows_exception: 'Shows a problem',
};

function EvidenceCard({ item, canReview, canWithdraw }: { item: EvidenceItem; canReview: boolean; canWithdraw: boolean }) {
  const impersonating = getImpersonation() !== null;
  const review = useReviewEvidence();
  const withdraw = useWithdrawEvidence();
  const [confirming, setConfirming] = useState(false);
  const err = friendlyError(review.error ?? withdraw.error);
  return (
    <li className="py-3 space-y-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
          <p className="text-xs text-zinc-500">
            {item.trust_label}
            {item.source_system ? `, from ${item.source_system}` : ''}
            {item.owner_name ? `, owned by ${item.owner_name}` : ''}
          </p>
          {item.scan_note && <p className="text-xs text-amber-700 dark:text-amber-400">{item.scan_note}</p>}
        </div>
        <div className="text-right text-xs">
          <p className="text-zinc-700 dark:text-zinc-300">{statusWords(item)}</p>
          {item.status === 'active' && item.days_left !== null && <p className="text-amber-700 dark:text-amber-400">{expiresText(item.days_left)}</p>}
        </div>
      </div>
      {item.links.length > 0 && (
        <ul className="pl-3 space-y-1">
          {item.links.map((l) => (
            <li key={l.assertion_id} className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span>Proves: {l.control_title}</span>
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5">
                {VERDICT_WORDS[l.review_verdict]}
                {l.reviewed_by_name ? ` by ${l.reviewed_by_name}` : ''}
                {l.small_team_self_review ? ' (self-review, small team)' : ''}
              </span>
              {canReview && l.review_verdict === 'pending' && item.status === 'active' && (
                <>
                  <button
                    type="button"
                    className={secondary}
                    disabled={impersonating || review.isPending}
                    onClick={() => review.mutate({ id: item.id, assertion_id: l.assertion_id, verdict: 'accepted', expected_verdict: l.review_verdict })}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    disabled={impersonating || review.isPending}
                    onClick={() => review.mutate({ id: item.id, assertion_id: l.assertion_id, verdict: 'shows_exception', expected_verdict: l.review_verdict })}
                  >
                    Shows a problem
                  </button>
                  {impersonating && <span>You are viewing as someone else, so you cannot review evidence for them.</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWithdraw && item.status !== 'withdrawn' && (
        <div className="flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-zinc-700 dark:text-zinc-300">Withdraw this evidence? It will stop counting as proof.</span>
              <button type="button" className={primary} disabled={withdraw.isPending} onClick={() => withdraw.mutate(item.id, { onSuccess: () => setConfirming(false) })}>
                Yes, withdraw
              </button>
              <button type="button" className={secondary} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={secondary} onClick={() => setConfirming(true)}>
              Withdraw
            </button>
          )}
        </div>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </li>
  );
}

function StuckScans({ items }: { items: EvidenceItem[] }) {
  const check = useCheckScanAgain();
  if (items.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-300 dark:border-amber-800 p-4">
      <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Waiting more than a day for a virus scan</h2>
      <ul className="mt-2 space-y-2">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-4 text-sm">
            <span>{i.title}</span>
            <button type="button" className={secondary} disabled={check.isPending} onClick={() => check.mutate(i.id)}>
              Check again
            </button>
          </li>
        ))}
      </ul>
      {check.data && (
        <p className="mt-2 text-xs text-zinc-600">
          {check.data.data.check_result === 'copied'
            ? 'The scan finished and the file is saved.'
            : check.data.data.check_result === 'copy_started'
              ? 'The scan finished. The file is large, so it is being saved now; this can take a minute or two.'
              : 'Still waiting for the scan.'}
        </p>
      )}
      {check.error && <p className="mt-2 text-xs text-red-600">{friendlyError(check.error)}</p>}
    </section>
  );
}

function AddEvidenceForm({ onDone }: { onDone: () => void }) {
  const user = useAuthStore((s) => s.user);
  const create = useCreateEvidence();
  const [kind, setKind] = useState<'file' | 'attestation_statement'>('file');
  const [f, setF] = useState({
    bin_asset_id: '',
    statement: '',
    title: '',
    source_system: '',
    produced_on: '',
    period_start: '',
    period_end: '',
    valid_until: '',
    sensitivity: 'standard' as 'standard' | 'restricted',
    confirm: false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const common = {
      title: f.title,
      source_system: f.source_system,
      owner_user_id: user.id,
      produced_on: f.produced_on,
      period_start: f.period_start || null,
      period_end: f.period_end || null,
      valid_until: f.valid_until,
      sensitivity: f.sensitivity,
      uploader_statement: true as const,
    };
    const body: BastionManualEvidenceCreate =
      kind === 'file' ? { kind: 'file', bin_asset_id: f.bin_asset_id.trim(), ...common } : { kind: 'attestation_statement', statement: f.statement, ...common };
    create.mutate(body, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3" aria-label="Add evidence">
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={kind === 'file'} onChange={() => setKind('file')} /> A file from Bin
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={kind === 'attestation_statement'} onChange={() => setKind('attestation_statement')} /> A written statement
        </label>
      </div>
      {kind === 'file' ? (
        <label className="block text-sm">
          The file's Bin link or code (upload it to Bin first)
          <input className={input} value={f.bin_asset_id} onChange={set('bin_asset_id')} required />
        </label>
      ) : (
        <label className="block text-sm">
          What you are stating
          <textarea className={input} rows={3} value={f.statement} onChange={set('statement')} required />
        </label>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          What is it
          <input className={input} value={f.title} onChange={set('title')} required />
        </label>
        <label className="block text-sm">
          Which system produced it
          <input className={input} value={f.source_system} onChange={set('source_system')} required />
        </label>
        <label className="block text-sm">
          Produced on
          <input type="date" className={input} value={f.produced_on} onChange={set('produced_on')} required />
        </label>
        <label className="block text-sm">
          Good until
          <input type="date" className={input} value={f.valid_until} onChange={set('valid_until')} required />
        </label>
        <label className="block text-sm">
          Covers from (optional)
          <input type="date" className={input} value={f.period_start} onChange={set('period_start')} />
        </label>
        <label className="block text-sm">
          Covers to (optional)
          <input type="date" className={input} value={f.period_end} onChange={set('period_end')} />
        </label>
        <label className="block text-sm">
          Who can see it
          <select className={input} value={f.sensitivity} onChange={set('sensitivity')}>
            <option value="standard">Everyone who can see evidence</option>
            <option value="restricted">Only people allowed to see restricted evidence</option>
          </select>
        </label>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 self-end">Owner: {user?.display_name ?? 'you'}</p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.checked })} />
        <span>I confirm this is a true and unaltered copy of what the system produced, and that it is fit to show an auditor.</span>
      </label>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={!f.confirm || create.isPending}>
          Save evidence
        </button>
        <button type="button" className={secondary} onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.error && <p className="text-xs text-red-600">{friendlyError(create.error)}</p>}
    </form>
  );
}

function FeedKeys({ feed }: { feed: FeedRow }) {
  const keys = useFeedKeys(feed.id);
  const mint = useMintFeedKey();
  const revoke = useRevokeFeedKey();
  const [shown, setShown] = useState<MintedKey | null>(null);
  return (
    <div className="pl-3 space-y-2">
      {feed.source_kind === 'api_push' && (
        <button
          type="button"
          className={secondary}
          disabled={mint.isPending}
          onClick={() => mint.mutate({ feedId: feed.id }, { onSuccess: (r) => setShown(r.data) })}
        >
          New key
        </button>
      )}
      {shown && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-2" data-testid="minted-token">
          <p className="font-medium">Copy this key now. It is shown only once and cannot be shown again.</p>
          <code className="block break-all text-xs">{shown.token}</code>
          <div className="flex gap-2">
            <button type="button" className={secondary} onClick={() => void navigator.clipboard?.writeText(shown.token)}>
              <Copy className="inline h-3.5 w-3.5 mr-1" />
              Copy
            </button>
            <button type="button" className={secondary} onClick={() => setShown(null)}>
              I have saved it
            </button>
          </div>
          {shown.grace_expires_at && <p className="text-xs">The previous key keeps working for seven more days.</p>}
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {(keys.data?.data ?? []).map((k) => (
          <li key={k.id} className="flex items-center gap-2">
            <span>
              Key ending {k.last4 ?? '????'}
              {k.label ? ` (${k.label})` : ''}: {k.status === 'active' ? 'in use' : k.status === 'grace' ? 'being replaced' : 'revoked'}
            </span>
            {k.status !== 'revoked' && (
              <button type="button" className={secondary} disabled={revoke.isPending} onClick={() => revoke.mutate(k.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeedsSection({ canManage }: { canManage: boolean }) {
  const canRead = useCan('bastion.feed.read');
  const feeds = useFeeds(canRead);
  const create = useCreateFeed();
  const [form, setForm] = useState({ feed_key: '', label: '' });
  if (!canRead) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Feeds</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Systems outside the suite can send records here with their own key.</p>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4">
        {(feeds.data?.data ?? []).map((fd) => (
          <li key={fd.id} className="py-3 space-y-2">
            <div className="flex justify-between gap-4 text-sm">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{fd.label}</span>
              <span className="text-zinc-600 dark:text-zinc-400">
                {fd.freshness}, {fd.records_today} today
              </span>
            </div>
            {canManage && <FeedKeys feed={fd} />}
          </li>
        ))}
        {feeds.data && feeds.data.data.length === 0 && <li className="py-3 text-sm text-zinc-600">No feeds yet.</li>}
      </ul>
      {canManage && (
        <form
          aria-label="New feed"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ feed_key: form.feed_key, label: form.label }, { onSuccess: () => setForm({ feed_key: '', label: '' }) });
          }}
        >
          <label className="text-sm">
            Feed name
            <input className={input} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
          </label>
          <label className="text-sm">
            Short key (lower-case, used in the push address)
            <input className={input} value={form.feed_key} onChange={(e) => setForm({ ...form, feed_key: e.target.value })} required />
          </label>
          <button type="submit" className={primary} disabled={create.isPending}>
            Add feed
          </button>
          {create.error && <p className="text-xs text-red-600 w-full">{friendlyError(create.error)}</p>}
        </form>
      )}
    </section>
  );
}

export function EvidencePage() {
  const list = useManualEvidence();
  const canUpload = useCan('bastion.evidence.upload');
  const canReview = useCan('bastion.evidence.review');
  const canWithdraw = useCan('bastion.evidence.withdraw');
  const canManageFeeds = useCan('bastion.feed.manage');
  const [adding, setAdding] = useState(false);

  if (list.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  if (list.error || !list.data) {
    return <p className="p-8 text-sm text-red-600">{list.error ? friendlyError(list.error) : 'The Evidence locker could not be loaded.'}</p>;
  }
  const items = list.data.data;
  const stuck = items.filter((i) => i.stuck_scan);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Evidence locker</h1>
        {canUpload && !adding && (
          <button type="button" className={primary} onClick={() => setAdding(true)}>
            Add evidence
          </button>
        )}
      </div>
      {adding && <AddEvidenceForm onDone={() => setAdding(false)} />}
      <StuckScans items={stuck} />
      {items.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Nothing uploaded yet. You can upload a report from the system that knows, or write a statement.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4">
          {items.map((i) => (
            <EvidenceCard key={i.id} item={i} canReview={canReview} canWithdraw={canWithdraw} />
          ))}
        </ul>
      )}
      <FeedsSection canManage={canManageFeeds} />
    </div>
  );
}
