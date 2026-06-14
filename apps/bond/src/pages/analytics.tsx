import { useMemo } from 'react';
import { TrendingUp, DollarSign, Clock, AlertTriangle, Trophy } from 'lucide-react';
import { Badge } from '@/components/common/badge';
import {
  usePipelineSummary,
  useConversionRates,
  useDealVelocity,
  useWinLossStats,
  useForecast,
  useStaleDeals,
} from '@/hooks/use-analytics';
import { usePipelines } from '@/hooks/use-pipelines';
import { usePipelineStore } from '@/stores/pipeline.store';
import { formatCurrencyCompact } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface AnalyticsPageProps {
  onNavigate: (path: string) => void;
}

function StatCard({
  label,
  value,
  subValue,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  subValue?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div
          className="flex items-center justify-center h-9 w-9 rounded-lg"
          style={{ backgroundColor: `${color}15`, color }}
        >
          <Icon className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm text-zinc-500">{label}</span>
      </div>
      <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value}</p>
      {subValue && <p className="text-sm text-zinc-500 mt-1">{subValue}</p>}
    </div>
  );
}

// Human-friendly labels for the forecast buckets returned by the API.
const FORECAST_BUCKET_LABELS: Array<{
  key: 'next_30' | 'next_60' | 'next_90' | 'beyond' | 'no_date';
  label: string;
}> = [
  { key: 'next_30', label: 'Next 30 days' },
  { key: 'next_60', label: 'Next 60 days' },
  { key: 'next_90', label: 'Next 90 days' },
  { key: 'beyond', label: 'Beyond 90 days' },
  { key: 'no_date', label: 'No close date' },
];

export function AnalyticsPage({ onNavigate }: AnalyticsPageProps) {
  const activePipelineId = usePipelineStore((s) => s.activePipelineId);

  // Resolve an effective pipeline id: the explicitly-selected one, otherwise
  // the org's default pipeline (or the first available). deal-velocity and
  // conversion-rates require a pipeline_id server-side, so we feed them this
  // resolved value and let their hooks no-op when it is still undefined.
  const { data: pipelinesData } = usePipelines();
  const pipelines = pipelinesData?.data ?? [];
  const effectivePipelineId =
    activePipelineId ??
    pipelines.find((p) => p.is_default)?.id ??
    pipelines[0]?.id ??
    undefined;
  const pipelineName =
    pipelines.find((p) => p.id === effectivePipelineId)?.name ?? 'Pipeline';

  const { data: summaryData, isLoading: summaryLoading } = usePipelineSummary(
    effectivePipelineId,
  );
  const summary = summaryData?.data;
  const totals = summary?.totals;
  const stages = summary?.stages ?? [];

  const { data: velocityData } = useDealVelocity(effectivePipelineId);
  const velocityStages = velocityData?.data?.stage_velocity ?? [];

  const { data: winLossData } = useWinLossStats(effectivePipelineId);
  const winLoss = winLossData?.data;
  const lossReasons = winLoss?.loss_reasons ?? [];
  const competitors = winLoss?.competitors ?? [];

  const { data: forecastData } = useForecast(effectivePipelineId);
  const forecastBuckets = forecastData?.data?.buckets;
  const forecastRows = useMemo(
    () =>
      forecastBuckets
        ? FORECAST_BUCKET_LABELS.map(({ key, label }) => ({
            key,
            label,
            weighted_value: forecastBuckets[key] ?? 0,
          })).filter((row) => row.weighted_value > 0)
        : [],
    [forecastBuckets],
  );

  const { data: staleData } = useStaleDeals(effectivePipelineId);
  const staleDeals = staleData?.data?.stale_deals ?? [];

  const { data: conversionData } = useConversionRates(effectivePipelineId);
  const conversionRows = useMemo(() => {
    const resp = conversionData?.data;
    if (!resp) return [];
    const stageName = new Map(resp.stages.map((s) => [s.id, s.name]));
    return (resp.conversions ?? []).map((c) => ({
      from_stage: stageName.get(c.from_stage_id) ?? 'Unknown',
      to_stage: stageName.get(c.to_stage_id) ?? 'Unknown',
      transition_count: c.transition_count,
    }));
  }, [conversionData]);

  if (summaryLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Analytics</h2>
        <p className="text-sm text-zinc-500 mt-0.5">{pipelineName} overview</p>
      </div>

      <div className="flex-1 p-6 space-y-8">
        {/* Top-level stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Pipeline"
            value={formatCurrencyCompact(totals?.total_value ?? 0)}
            subValue={`${totals?.deal_count ?? 0} deals`}
            icon={DollarSign}
            color="#16a34a"
          />
          <StatCard
            label="Weighted Forecast"
            value={formatCurrencyCompact(totals?.weighted_value ?? 0)}
            icon={TrendingUp}
            color="#0891b2"
          />
          <StatCard
            label="Win Rate"
            value={winLoss ? `${winLoss.win_rate_pct ?? 0}%` : '-'}
            subValue={
              winLoss
                ? `${winLoss.won_count ?? 0} won / ${winLoss.lost_count ?? 0} lost`
                : undefined
            }
            icon={Trophy}
            color="#f59e0b"
          />
          <StatCard
            label="Stale Deals"
            value={String(staleDeals.length)}
            subValue={staleDeals.length > 0 ? 'Needs attention' : 'All healthy'}
            icon={AlertTriangle}
            color={staleDeals.length > 0 ? '#dc2626' : '#16a34a'}
          />
        </div>

        {/* Pipeline funnel */}
        {stages.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Pipeline Stages</h3>
            <div className="grid grid-cols-1 gap-3">
              {stages
                .filter((s) => s.stage_type === 'active')
                .map((stage) => {
                  const totalValue = totals?.total_value ?? 0;
                  const stageValue = stage.total_value ?? 0;
                  const pct = totalValue > 0 ? (stageValue / totalValue) * 100 : 0;
                  return (
                    <div key={stage.stage_id} className="flex items-center gap-4">
                      <div className="w-32 text-sm text-zinc-700 dark:text-zinc-300 truncate">
                        {stage.stage_name}
                      </div>
                      <div className="flex-1 h-8 bg-zinc-100 dark:bg-zinc-800 rounded-lg overflow-hidden relative">
                        <div
                          className="h-full rounded-lg transition-all duration-500"
                          style={{
                            width: `${Math.max(pct, 2)}%`,
                            backgroundColor: stage.color ?? '#0891b2',
                          }}
                        />
                        <div className="absolute inset-0 flex items-center justify-between px-3">
                          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            {stage.deal_count ?? 0} deals
                          </span>
                          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                            {formatCurrencyCompact(stage.total_value)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Deal Velocity */}
        {velocityStages.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Average Deal Velocity (days per stage)</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {velocityStages.map((v) => (
                <div
                  key={v.stage_id}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4 text-center"
                >
                  <p className="text-sm text-zinc-500 mb-1">{v.stage_name}</p>
                  <p className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center justify-center gap-1">
                    <Clock className="h-4 w-4 text-primary-500" />
                    {v.avg_duration_days != null ? `${v.avg_duration_days.toFixed(1)}d` : '-'}
                  </p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {v.sample_count ?? 0} sample{v.sample_count === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Conversion counts */}
        {conversionRows.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Stage Transitions</h3>
            <div className="flex items-center gap-3 flex-wrap">
              {conversionRows.map((c, i) => (
                <div
                  key={`${c.from_stage}-${c.to_stage}-${i}`}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5"
                >
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">{c.from_stage}</span>
                  <span className="text-zinc-400">→</span>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">{c.to_stage}</span>
                  <Badge variant="info">{c.transition_count}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Revenue forecast */}
        {forecastRows.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Revenue Forecast (weighted)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {forecastRows.map((bucket) => (
                <div
                  key={bucket.key}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4"
                >
                  <p className="text-sm text-zinc-500 mb-2">{bucket.label}</p>
                  <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                    {formatCurrencyCompact(bucket.weighted_value)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stale deals */}
        {staleDeals.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Stale Deals ({staleDeals.length})
            </h3>
            <div className="space-y-2">
              {staleDeals.map((deal) => (
                <div
                  key={deal.deal_id}
                  onClick={() => onNavigate(`/deals/${deal.deal_id}`)}
                  className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{deal.deal_name}</p>
                    <p className="text-xs text-zinc-500">{deal.stage_name ?? 'No stage'}</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="danger">
                      {deal.days_in_stage ?? 0}d / {deal.rotting_days_threshold ?? 0}d
                    </Badge>
                    {deal.value != null && (
                      <p className="text-xs text-zinc-500 mt-1">{formatCurrencyCompact(deal.value)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Win/Loss details */}
        {winLoss && (lossReasons.length > 0 || competitors.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {lossReasons.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Top Loss Reasons</h3>
                <div className="space-y-2">
                  {lossReasons.map((r, i) => (
                    <div key={`${r.reason}-${i}`} className="flex items-center justify-between text-sm">
                      <span className="text-zinc-600 dark:text-zinc-400">{r.reason}</span>
                      <Badge variant="danger">{r.count}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {competitors.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Top Competitors</h3>
                <div className="space-y-2">
                  {competitors.map((c, i) => (
                    <div key={`${c.name}-${i}`} className="flex items-center justify-between text-sm">
                      <span className="text-zinc-600 dark:text-zinc-400">{c.name}</span>
                      <Badge>{c.count} losses</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
