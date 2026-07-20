import { useState } from 'react';
import { FileText, Plus, ChevronRight } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BursarRequestCreate } from '@bigbluebam/shared';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn, Pill } from '@/components/primitives';
import { useRequests, useCreateRequest } from '@/hooks/use-bursar';
import type { RequestRow } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

const SCOPE_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  confirmed: 'green',
  derived: 'sky',
  deriving: 'amber',
  awarded: 'violet',
  pending: 'zinc',
  none: 'zinc',
};

export function RequestsListPage({ onNavigate }: Props) {
  const canWrite = useCan('bursar.request.write');
  const { data, isLoading, isError } = useRequests();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Requests"
        subtitle="Each request carries a confirmed scope tree - the ruler that every offer is measured against."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setShowCreate((s) => !s)}>
              <Plus className="h-4 w-4" /> New request
            </Btn>
          ) : undefined
        }
      />

      {showCreate && canWrite && (
        <CreateRequestForm onClose={() => setShowCreate(false)} onCreated={(id) => onNavigate(`/requests/${id}`)} />
      )}

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message="Could not load requests." />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          title="No requests yet"
          hint="Create a request and derive its scope tree to start leveling offers against it."
          icon={<FileText className="h-8 w-8" />}
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data!.data.map((r) => (
                <RequestRowView key={r.id} request={r} onOpen={() => onNavigate(`/requests/${r.id}`)} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function RequestRowView({ request, onOpen }: { request: RequestRow; onOpen: () => void }) {
  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer" onClick={onOpen}>
      <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
        {request.title}
        {request.injection_suspected && (
          <span className="ml-2">
            <Pill tone="red">manipulation suspected</Pill>
          </span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <Pill tone={SCOPE_TONE[request.scope_status] ?? 'zinc'}>{request.scope_status}</Pill>
      </td>
      <td className="px-4 py-2.5 text-zinc-500">{formatDate(request.created_at)}</td>
      <td className="px-4 py-2.5 text-right">
        <ChevronRight className="inline h-4 w-4 text-zinc-300" />
      </td>
    </tr>
  );
}

const inputCls =
  'w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm';

function CreateRequestForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreateRequest();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');

  const submit = () => {
    const input: BursarRequestCreate = {
      title: title.trim(),
      currency: currency.trim().toUpperCase() || 'USD',
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    create.mutate(input, { onSuccess: (res) => onCreated(res.data.id) });
  };
  const err = create.error instanceof ApiError ? create.error : null;

  return (
    <Card className="mb-6 p-4 space-y-3">
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">New request</div>
      <label className="block">
        <span className="block text-xs text-zinc-500 mb-1">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="e.g. Castaway Rescue Platform RFQ" />
      </label>
      <label className="block">
        <span className="block text-xs text-zinc-500 mb-1">Description (optional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} rows={2} />
      </label>
      <label className="block max-w-[8rem]">
        <span className="block text-xs text-zinc-500 mb-1">Currency</span>
        <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} className={inputCls} />
      </label>
      {err && <p className="text-xs text-red-500">{err.message}</p>}
      <div className="flex items-center gap-2">
        <Btn variant="primary" size="sm" disabled={!title.trim() || create.isPending} onClick={submit}>
          {create.isPending ? 'Creating...' : 'Create request'}
        </Btn>
        <Btn variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}
