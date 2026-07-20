import { CalendarClock } from 'lucide-react';
import { PageHeader, Card, LoadingState, EmptyState, Pill } from '@/components/primitives';
import { useRenewals } from '@/hooks/use-bursar';
import { formatDate } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

const BAND_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  overdue: 'red',
  urgent: 'red',
  soon: 'amber',
  upcoming: 'sky',
};

export function RenewalRadarPage({ onNavigate }: Props) {
  const { data, isLoading, isError } = useRenewals();

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Renewal Radar"
        subtitle="Awards approaching renewal, grouped by how much notice lead time remains."
      />

      {isLoading ? (
        <LoadingState />
      ) : isError || (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          title="Nothing renewing"
          hint="No awards are inside a renewal lead band, or the renewal endpoint is not wired into the stack yet."
          icon={<CalendarClock className="h-8 w-8" />}
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Lead band</th>
                <th className="px-4 py-2 font-medium">Renews</th>
                <th className="px-4 py-2 font-medium">Notice by</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data!.data.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <td className="px-4 py-2.5">
                    <Pill tone={BAND_TONE[r.lead_band ?? ''] ?? 'zinc'}>{r.lead_band ?? 'unbanded'}</Pill>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-200">{formatDate(r.renews_at)}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(r.notice_by)}</td>
                  <td className="px-4 py-2.5">
                    <Pill tone="zinc">{r.status}</Pill>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.vendor_id && (
                      <button className="text-primary-600 hover:underline text-xs" onClick={() => onNavigate(`/vendors/${r.vendor_id}`)}>
                        vendor
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
