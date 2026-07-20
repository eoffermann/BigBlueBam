import { useMemo, useState } from 'react';
import { Store, Plus, ChevronRight } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BursarVendorCreate } from '@bigbluebam/shared';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn, Pill } from '@/components/primitives';
import { useVendors, useAwards, useCreateVendor } from '@/hooks/use-bursar';
import type { AwardRow, VendorRow } from '@/lib/api';
import { ApiError } from '@/lib/api';

interface Props {
  onNavigate: (path: string) => void;
}

const CRITICALITY_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  critical: 'red',
  high: 'amber',
  standard: 'zinc',
  low: 'zinc',
};

export function VendorPortfolioPage({ onNavigate }: Props) {
  const canWrite = useCan('bursar.vendor.write');
  const { data, isLoading, isError } = useVendors('active');
  const awards = useAwards();
  const [showCreate, setShowCreate] = useState(false);

  // vendor_id -> most recent award (M7 surface). If /awards is not mounted yet the query soft-fails
  // and every vendor reads "No award on file", which is exactly the first-class column we want.
  const awardByVendor = useMemo(() => {
    const m = new Map<string, AwardRow>();
    for (const a of awards.data?.data ?? []) {
      if (!a.vendor_id) continue;
      const prev = m.get(a.vendor_id);
      if (!prev || (a.created_at ?? '') > (prev.created_at ?? '')) m.set(a.vendor_id, a);
    }
    return m;
  }, [awards.data]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Vendor Portfolio"
        subtitle="Every vendor you buy from, with award status as a first-class column. A vendor with spend but no award on file is the thing to notice."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setShowCreate((s) => !s)}>
              <Plus className="h-4 w-4" /> Add vendor
            </Btn>
          ) : undefined
        }
      />

      {showCreate && canWrite && (
        <CreateVendorForm onClose={() => setShowCreate(false)} onCreated={(id) => onNavigate(`/vendors/${id}`)} />
      )}

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message="Could not load vendors." />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          title="No vendors yet"
          hint="Add a vendor to start tracking its awards, spend, and renewal notices."
          icon={<Store className="h-8 w-8" />}
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Criticality</th>
                <th className="px-4 py-2 font-medium">Award</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data!.data.map((v) => (
                <VendorRowView
                  key={v.id}
                  vendor={v}
                  award={awardByVendor.get(v.id) ?? null}
                  onOpen={() => onNavigate(`/vendors/${v.id}`)}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function VendorRowView({ vendor, award, onOpen }: { vendor: VendorRow; award: AwardRow | null; onOpen: () => void }) {
  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer" onClick={onOpen}>
      <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{vendor.display_name}</td>
      <td className="px-4 py-2.5 text-zinc-500">{vendor.category ?? '-'}</td>
      <td className="px-4 py-2.5">
        <Pill tone={CRITICALITY_TONE[vendor.criticality] ?? 'zinc'}>{vendor.criticality}</Pill>
      </td>
      <td className="px-4 py-2.5">
        {award ? (
          <Pill tone={award.orphaned_custody ? 'red' : 'green'}>
            {award.orphaned_custody ? 'Orphaned custody' : award.status || 'Awarded'}
          </Pill>
        ) : (
          <Pill tone="amber" testId="no-award-on-file">
            No award on file
          </Pill>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <ChevronRight className="inline h-4 w-4 text-zinc-300" />
      </td>
    </tr>
  );
}

const inputCls =
  'w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm';

function CreateVendorForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreateVendor();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [criticality, setCriticality] = useState<BursarVendorCreate['criticality']>('standard');

  const submit = () => {
    const input: BursarVendorCreate = {
      display_name: name.trim(),
      criticality,
      ...(category.trim() ? { category: category.trim() } : {}),
    };
    create.mutate(input, { onSuccess: (res) => onCreated(res.data.id) });
  };
  const err = create.error instanceof ApiError ? create.error : null;

  return (
    <Card className="mb-6 p-4 space-y-3">
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Add vendor</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Howell Provisioning Co." />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Category</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls} placeholder="optional" />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Criticality</span>
          <select
            value={criticality}
            onChange={(e) => setCriticality(e.target.value as BursarVendorCreate['criticality'])}
            className={inputCls}
          >
            {(['low', 'standard', 'high', 'critical'] as const).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      {err && <p className="text-xs text-red-500">{err.message}</p>}
      <div className="flex items-center gap-2">
        <Btn variant="primary" size="sm" disabled={!name.trim() || create.isPending} onClick={submit}>
          {create.isPending ? 'Adding...' : 'Add vendor'}
        </Btn>
        <Btn variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}
