import { useMemo } from 'react';
import { Link2, Award, Snowflake, Receipt, AlertTriangle } from 'lucide-react';
import { PageHeader, Card, LoadingState, ErrorState, Pill } from '@/components/primitives';
import {
  useVendor,
  useVendorAliases,
  useAwards,
  useBaseline,
  useSpendByVendor,
  useMismatches,
} from '@/hooks/use-bursar';
import type { AwardRow } from '@/lib/api';
import { formatCents, formatDate } from '@/lib/utils';

interface Props {
  vendorId: string;
  onNavigate: (path: string) => void;
}

export function VendorDetailPage({ vendorId, onNavigate }: Props) {
  const vendor = useVendor(vendorId);
  const aliases = useVendorAliases(vendorId);
  const awards = useAwards(vendorId);
  const spend = useSpendByVendor(vendorId);
  const mismatches = useMismatches(vendorId);

  // The active award (most recent) drives the baseline lookup and the orphaned-custody badge.
  const activeAward: AwardRow | null = useMemo(() => {
    const rows = [...(awards.data?.data ?? [])];
    rows.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    return rows[0] ?? null;
  }, [awards.data]);
  const baseline = useBaseline(activeAward?.id);

  if (vendor.isLoading) return <LoadingState label="Loading vendor..." />;
  if (vendor.isError || !vendor.data) return <ErrorState message="Could not load this vendor." />;
  const v = vendor.data.data;
  const orphaned = !!activeAward?.orphaned_custody;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title={v.display_name}
        subtitle={v.category ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Pill tone={v.criticality === 'critical' ? 'red' : v.criticality === 'high' ? 'amber' : 'zinc'}>
              {v.criticality}
            </Pill>
            <Pill tone={v.status === 'archived' ? 'zinc' : 'green'}>{v.status}</Pill>
            {orphaned && (
              <Pill tone="red" testId="orphaned-custody">
                orphaned custody
              </Pill>
            )}
          </div>
        }
      />

      {orphaned && (
        <div className="mb-6 rounded border border-red-300 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 px-3 py-2 text-sm flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <strong>Orphaned custody.</strong> This vendor has an award whose owning request or offer can no longer be
            resolved. The baseline still holds, but the chain that produced it is broken.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Award chain */}
        <Section title="Award chain" icon={<Award className="h-4 w-4" />} loading={awards.isLoading} soft={awards.isError}>
          {(awards.data?.data.length ?? 0) === 0 ? (
            <Empty label="No award on file for this vendor." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {awards.data!.data.map((a) => (
                <li key={a.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Pill tone={a.orphaned_custody ? 'red' : 'green'}>{a.status || 'awarded'}</Pill>
                    {a.request_id && (
                      <button
                        className="text-primary-600 hover:underline text-xs"
                        onClick={() => onNavigate(`/requests/${a.request_id}`)}
                      >
                        request
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-zinc-500">{formatDate(a.awarded_at ?? a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Baseline */}
        <Section
          title="Baseline"
          icon={<Snowflake className="h-4 w-4" />}
          loading={!!activeAward && baseline.isLoading}
          soft={baseline.isError}
        >
          {!activeAward ? (
            <Empty label="No award, so no frozen baseline." />
          ) : baseline.data?.data ? (
            <div className="text-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Frozen</span>
                <span>{formatDate(baseline.data.data.frozen_at)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Total</span>
                <span className="font-medium">
                  {formatCents(baseline.data.data.total_minor ?? null, baseline.data.data.currency ?? 'USD')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Items</span>
                <span>{baseline.data.data.item_count ?? 0}</span>
              </div>
            </div>
          ) : (
            <Empty label="Baseline not frozen yet." />
          )}
        </Section>

        {/* Spend */}
        <Section title="Spend" icon={<Receipt className="h-4 w-4" />} loading={spend.isLoading} soft={spend.isError}>
          {(spend.data?.data.length ?? 0) === 0 ? (
            <Empty label="No spend recorded against this vendor." />
          ) : (
            <ul className="space-y-1 text-sm">
              {spend.data!.data.map((s, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="text-zinc-500">{s.event_count ?? 0} event{(s.event_count ?? 0) === 1 ? '' : 's'}</span>
                  <span className="font-medium">{formatCents(s.total_minor ?? null, s.currency ?? 'USD')}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Findings */}
        <Section title="Findings" icon={<AlertTriangle className="h-4 w-4" />} loading={mismatches.isLoading} soft={mismatches.isError}>
          {(mismatches.data?.data.length ?? 0) === 0 ? (
            <Empty label="No open findings." />
          ) : (
            <ul className="space-y-2 text-sm">
              {mismatches.data!.data.map((m) => (
                <li key={m.id} className="flex items-start gap-2">
                  <Pill tone={m.severity === 'high' ? 'red' : m.severity === 'medium' ? 'amber' : 'zinc'}>
                    {m.severity}
                  </Pill>
                  <span className="text-zinc-600 dark:text-zinc-300">{m.summary ?? m.detector}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Aliases */}
        <Section title="Payee aliases" icon={<Link2 className="h-4 w-4" />} loading={aliases.isLoading} soft={aliases.isError}>
          {(aliases.data?.data.length ?? 0) === 0 ? (
            <Empty label="No linked payee strings." />
          ) : (
            <ul className="space-y-1 text-sm">
              {aliases.data!.data.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="text-zinc-700 dark:text-zinc-200 truncate">{a.raw_payee}</span>
                  <Pill tone={a.source === 'human' ? 'green' : 'zinc'}>{a.source}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  loading,
  soft,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  loading?: boolean;
  soft?: boolean; // endpoint not mounted yet -> render as empty, never as an error
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
        <span className="text-zinc-400">{icon}</span>
        {title}
      </div>
      {loading ? (
        <div className="py-6 text-center text-xs text-zinc-400">Loading...</div>
      ) : soft ? (
        <Empty label="Not available yet." />
      ) : (
        children
      )}
    </Card>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="text-xs text-zinc-400 py-2">{label}</p>;
}
