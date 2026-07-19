import { useMemo, useState } from 'react';
import { ClipboardCheck, Loader2, Send, Plus, CheckCircle2 } from 'lucide-react';
import type { BulwarkComplianceDoc, BulwarkComplianceDocType } from '@bigbluebam/shared';
import { useCan } from '@bigbluebam/ui/use-can';
import {
  useVendorTiers,
  useComplianceDocs,
  useContracts,
  useCreateVendorTier,
  useDraftChase,
  useApproveSendChase,
} from '@/hooks/use-bulwark';
import { cn } from '@/lib/utils';
import { ValidityBadge, CollectionBadge, VendorChaseBadge } from '@/components/badges';

const DOC_TYPES: BulwarkComplianceDocType[] = ['coi', 'w9', 'lien_waiver', 'certified_payroll', 'other'];
const DOC_LABELS: Record<BulwarkComplianceDocType, string> = {
  coi: 'COI',
  w9: 'W-9',
  lien_waiver: 'Lien waiver',
  certified_payroll: 'Cert. payroll',
  other: 'Other',
};

interface Props {
  onNavigate: (path: string) => void;
}

export function VendorComplianceMatrixPage({ onNavigate }: Props) {
  const canChase = useCan('bulwark.compliance.chase');
  const tiersQuery = useVendorTiers({});
  const docsQuery = useComplianceDocs({});
  const [showAdd, setShowAdd] = useState(false);

  const tiers = tiersQuery.data?.data ?? [];
  const docs = docsQuery.data?.data ?? [];

  // Index docs by (vendor_tier_id, doc_type). If two share a slot, the most recent wins.
  const docIndex = useMemo(() => {
    const m = new Map<string, BulwarkComplianceDoc>();
    for (const d of docs) m.set(`${d.vendor_tier_id}::${d.doc_type}`, d);
    return m;
  }, [docs]);

  const loading = tiersQuery.isLoading || docsQuery.isLoading;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6 text-primary-500" />
            Vendor compliance
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Lower-tier vendors and the documents each is required to provide. Chase a missing or
            expiring doc; the request is drafted for a human to approve before it sends.
          </p>
        </div>
        {canChase && (
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium shrink-0"
          >
            <Plus className="h-4 w-4" />
            Add vendor tier
          </button>
        )}
      </div>

      {showAdd && canChase && <AddVendorTier onDone={() => setShowAdd(false)} />}

      {loading ? (
        <div className="space-y-3 mt-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
          ))}
        </div>
      ) : tiersQuery.isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load vendor tiers</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {tiersQuery.error instanceof Error ? tiersQuery.error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : tiers.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <ClipboardCheck className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No vendor tiers</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Add a lower-tier vendor to start tracking the compliance docs it owes.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3">Vendor tier</th>
                <th className="px-4 py-3">Chase</th>
                {DOC_TYPES.map((t) => (
                  <th key={t} className="px-3 py-3 text-center">
                    {DOC_LABELS[t]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-[11px] font-mono text-zinc-500">
                        T{tier.tier_level}
                      </span>
                      {tier.contract_id ? (
                        <button
                          onClick={() => onNavigate(`/contracts/${tier.contract_id}`)}
                          className="text-primary-600 dark:text-primary-400 hover:underline font-mono text-xs"
                        >
                          {tier.contract_id.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="text-xs text-zinc-400">org-level</span>
                      )}
                    </div>
                    {tier.vendor_id && (
                      <span className="text-[11px] text-zinc-400 font-mono block mt-1">
                        vendor {tier.vendor_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <VendorChaseBadge status={tier.chase_status} />
                  </td>
                  {DOC_TYPES.map((docType) => {
                    const doc = docIndex.get(`${tier.id}::${docType}`);
                    const required = tier.required_doc_types.includes(docType);
                    return (
                      <td key={docType} className="px-3 py-3 text-center align-top">
                        <ComplianceCell doc={doc} required={required} canChase={canChase} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ComplianceCell({
  doc,
  required,
  canChase,
}: {
  doc: BulwarkComplianceDoc | undefined;
  required: boolean;
  canChase: boolean;
}) {
  const draftChase = useDraftChase();
  const approveSend = useApproveSendChase();

  if (!doc) {
    return required ? (
      <span className="text-[11px] text-amber-600 dark:text-amber-400">required</span>
    ) : (
      <span className="text-zinc-300 dark:text-zinc-600">-</span>
    );
  }

  const chaseable = doc.collection_status !== 'collected' || doc.validity_status === 'expired';
  const drafted = doc.chase_status === 'drafted';

  return (
    <div className="flex flex-col items-center gap-1">
      <CollectionBadge status={doc.collection_status} />
      <ValidityBadge status={doc.validity_status} />
      {canChase && chaseable && (
        drafted ? (
          <button
            type="button"
            disabled={approveSend.isPending}
            onClick={() => approveSend.mutate(doc.id)}
            title="Approve and send the drafted chase"
            className="inline-flex items-center gap-0.5 rounded border border-primary-300 dark:border-primary-800 text-primary-700 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/10 px-1.5 py-0.5 text-[10px] font-medium disabled:opacity-60"
          >
            {approveSend.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
            Send
          </button>
        ) : (
          <button
            type="button"
            disabled={draftChase.isPending}
            onClick={() => draftChase.mutate(doc.id)}
            title="Draft a chase request"
            className="inline-flex items-center gap-0.5 rounded border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium disabled:opacity-60"
          >
            {draftChase.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Chase
          </button>
        )
      )}
    </div>
  );
}

function AddVendorTier({ onDone }: { onDone: () => void }) {
  const contractsQuery = useContracts({ limit: 100 });
  const create = useCreateVendorTier();
  const [contractId, setContractId] = useState('');
  const [tierLevel, setTierLevel] = useState('1');
  const [vendorId, setVendorId] = useState('');

  const inputCls =
    'rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm';

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-4">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Add a vendor tier</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Parent contract</label>
          <select value={contractId} onChange={(e) => setContractId(e.target.value)} className={inputCls}>
            <option value="">(org-level, owner/admin)</option>
            {(contractsQuery.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Tier level</label>
          <input value={tierLevel} onChange={(e) => setTierLevel(e.target.value)} className={inputCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Vendor id (bond.company, optional)</label>
          <input value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="uuid" className={inputCls} />
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          disabled={create.isPending}
          onClick={() =>
            create.mutate(
              {
                contract_id: contractId || null,
                tier_level: Number(tierLevel) || 1,
                vendor_type: vendorId ? 'bond.company' : null,
                vendor_id: vendorId || null,
              },
              { onSuccess: onDone },
            )
          }
          className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add tier
        </button>
        <button
          type="button"
          onClick={onDone}
          className={cn('rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300')}
        >
          Cancel
        </button>
        {create.isError && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            {create.error instanceof Error ? create.error.message : 'Could not add tier.'}
          </span>
        )}
      </div>
    </div>
  );
}
