import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { SUITE_LINK_REFUSAL, suiteLinkId, suiteLinkRef } from '@bigbluebam/shared';
import type { PolicyRow } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { useCreatePolicy, usePolicies, usePolicyAttestations, useRequestAttestations, useUpdatePolicy } from '@/hooks/use-bastion';

// Policies (spec 6.1, 3.6): the Beacon articles people must read and acknowledge, who has read the
// current version and who has not, and who cannot even open it. Linking, nudging and retiring are
// hidden from people who may not do them (useCan), never shown as an unexplained disabled button.


function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function audienceWords(p: PolicyRow): string {
  return p.audience.kind === 'all' ? 'Everyone' : `${p.audience.user_ids.length} ${p.audience.user_ids.length === 1 ? 'person' : 'people'}`;
}

function expiryWords(p: PolicyRow): string | null {
  if (!p.expires_at) return null;
  const d = p.days_to_expiry;
  if (d !== null && d < 0) return `Beacon marked it expired on ${formatDate(p.expires_at)}`;
  return `Beacon review due ${formatDate(p.expires_at)}${d !== null ? ` (in ${d} days)` : ''}`;
}

const btn = 'px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50';
const primary = `${btn} bg-primary-600 text-white hover:bg-primary-700`;
const secondary = `${btn} border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200`;

function WhoHasRead({ policyId }: { policyId: string }) {
  const q = usePolicyAttestations(policyId);
  if (q.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
  if (q.error) return <p className="text-xs text-red-600">{friendlyError(q.error)}</p>;
  const d = q.data?.data;
  if (!d) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 text-sm" data-testid="who-has-read">
      <div>
        <p className="font-medium text-zinc-800 dark:text-zinc-200">Has read the current version</p>
        {d.attested.length === 0 ? (
          <p className="text-zinc-500">Nobody yet.</p>
        ) : (
          <ul className="text-zinc-600 dark:text-zinc-400">
            {d.attested.map((a) => (
              <li key={a.user_id}>
                {a.name} <span className="text-xs text-zinc-500">on {formatDate(a.attested_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-medium text-zinc-800 dark:text-zinc-200">Has not read it yet</p>
        {d.not_attested.length === 0 ? (
          <p className="text-zinc-500">Everyone has read it.</p>
        ) : (
          <ul className="text-zinc-600 dark:text-zinc-400">
            {d.not_attested.map((a) => (
              <li key={a.user_id}>
                {a.name}
                {!a.can_open && <span className="text-xs text-amber-700"> (cannot open it)</span>}
              </li>
            ))}
          </ul>
        )}
        {d.cannot_open_label && (
          <p className="mt-2 text-xs text-amber-700" data-testid="cannot-open">
            {d.cannot_open_label}. In Beacon, share the article with everyone in your organization so they can read it.
          </p>
        )}
      </div>
    </div>
  );
}

function PolicyItem({ p }: { p: PolicyRow }) {
  const [open, setOpen] = useState(false);
  const canWrite = useCan('bastion.policy.write');
  const canRequest = useCan('bastion.attestation.request');
  const ask = useRequestAttestations();
  const update = useUpdatePolicy();
  const expiry = expiryWords(p);
  return (
    <li className="py-4 space-y-2" data-testid="policy-row">
      <div className="flex items-start justify-between gap-4">
        <button type="button" className="flex items-start gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />}
          <span>
            <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{p.title}</span>
            <span className="block text-xs text-zinc-600 dark:text-zinc-400">
              {audienceWords(p)} · Read every {p.cadence_days} days{p.owner_name ? ` · Owner: ${p.owner_name}` : ''}
              {p.status === 'retired' ? ' · Retired' : ''}
            </span>
            {p.attestation_label && <span className="block text-sm text-zinc-700 dark:text-zinc-300 mt-1">{p.attestation_label}</span>}
            {expiry && <span className="block text-xs text-zinc-500">{expiry}</span>}
          </span>
        </button>
        {p.status === 'active' && (
          <div className="flex gap-2 shrink-0">
            {canRequest && p.not_attested_count > 0 && (p.article_state ?? 'current') === 'current' && (
              <button type="button" className={primary} disabled={ask.isPending} onClick={() => ask.mutate(p.id)}>
                Ask people to read it
              </button>
            )}
            {canWrite && (
              <button type="button" className={secondary} disabled={update.isPending} onClick={() => update.mutate({ id: p.id, body: { status: 'retired' } })}>
                Retire
              </button>
            )}
          </div>
        )}
      </div>
      {p.article_problem && (
        <p className="text-xs text-red-700 bg-red-50 dark:bg-red-950/30 rounded px-2 py-1" data-testid="article-problem">
          {p.article_problem}
        </p>
      )}
      {p.sharing_problem && <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1">{p.sharing_problem}</p>}
      {ask.data && <p className="text-xs text-green-700">Asked {ask.data.data.nudged} {ask.data.data.nudged === 1 ? 'person' : 'people'} to read it.</p>}
      {(ask.error || update.error) && <p className="text-xs text-red-600">{friendlyError(ask.error ?? update.error)}</p>}
      {open && <WhoHasRead policyId={p.id} />}
    </li>
  );
}

/**
 * What a pasted Beacon link names: the article id, or the slug Beacon puts in its address bar
 * (/beacon/island-information-security-policy), which bastion-api resolves (#239). Null when the
 * paste is not a Beacon article link.
 */
export function beaconArticleFrom(text: string): { beacon_entry_id: string } | { beacon_slug: string } | null {
  const ref = suiteLinkRef(text, 'beacon');
  if (!ref) return null;
  return 'id' in ref ? { beacon_entry_id: ref.id } : { beacon_slug: ref.slug };
}

/** The article id in a pasted id-form link or bare id (slug links: use beaconArticleFrom). */
export function beaconEntryIdFrom(text: string): string | null {
  return suiteLinkId(text, 'beacon');
}

function LinkPolicyForm() {
  const create = useCreatePolicy();
  const [open, setOpen] = useState(false);
  const [article, setArticle] = useState('');
  const [days, setDays] = useState(365);
  const target = beaconArticleFrom(article);
  if (!open) {
    return (
      <button type="button" className={primary} onClick={() => setOpen(true)}>
        Link a Beacon article
      </button>
    );
  }
  return (
    <form
      className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!target) return;
        create.mutate(
          { ...target, audience: { kind: 'all' }, cadence_days: days },
          {
            onSuccess: () => {
              setOpen(false);
              setArticle('');
            },
          },
        );
      }}
    >
      <label className="block text-sm">
        <span className="text-zinc-700 dark:text-zinc-300">The Beacon article (paste its link)</span>
        <input
          className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
          value={article}
          onChange={(e) => setArticle(e.target.value)}
          placeholder="Open the article in Beacon and copy the address"
        />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-700 dark:text-zinc-300">Everyone reads it again every (days)</span>
        <input
          type="number"
          min={1}
          max={1095}
          className="mt-1 w-32 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
          value={days}
          onChange={(e) => setDays(Number(e.target.value) || 365)}
        />
      </label>
      <p className="text-xs text-zinc-500">
        Everyone in your organization will be asked to read it. The article must be shared with everyone in Beacon. If your security policy control is
        not linked to a policy yet, Bastion links its checks to this one for you to confirm in the Review queue.
      </p>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={!target || create.isPending}>
          Link this policy
        </button>
        <button type="button" className={secondary} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {article && !target && <p className="text-xs text-amber-700">{SUITE_LINK_REFUSAL.beacon}</p>}
      {create.error && <p className="text-xs text-red-600">{friendlyError(create.error)}</p>}
    </form>
  );
}

export function PoliciesPage() {
  const [showRetired, setShowRetired] = useState(false);
  const q = usePolicies(showRetired ? 'all' : 'active');
  const canWrite = useCan('bastion.policy.write');
  const rows = q.data?.data ?? [];
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Policies</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The written policies your team must read and acknowledge. A new version in Beacon means everyone reads it again.
          </p>
        </div>
        {canWrite && <LinkPolicyForm />}
      </div>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />}
      {q.error && <p className="text-sm text-red-600">{friendlyError(q.error)}</p>}
      {!q.isLoading && rows.length === 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="policies-empty">
          No policies yet. Write your security policy in Beacon, share it with everyone, then link it here so Bastion can track who has read it.
        </p>
      )}
      {rows.length > 0 && <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">{rows.map((p) => <PolicyItem key={p.id} p={p} />)}</ul>}
      <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
        Show retired policies
      </label>
    </div>
  );
}
