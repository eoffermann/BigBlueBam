import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types — these mirror the ACTUAL bond-api analytics response shapes
// (apps/bond-api/src/services/analytics.service.ts), NOT an idealized
// contract. Every field below is what the server really sends.
// ---------------------------------------------------------------------------

// --- pipeline-summary ------------------------------------------------------

export interface PipelineSummaryStage {
  stage_id: string;
  stage_name: string;
  stage_type: 'active' | 'won' | 'lost';
  sort_order: number;
  color: string | null;
  deal_count: number;
  total_value: number;
  weighted_value: number;
}

export interface PipelineSummary {
  stages: PipelineSummaryStage[];
  totals: {
    deal_count: number;
    total_value: number;
    weighted_value: number;
  };
}

// --- conversion-rates ------------------------------------------------------

export interface ConversionRatesResponse {
  stages: Array<{ id: string; name: string; sort_order: number }>;
  conversions: Array<{
    from_stage_id: string;
    to_stage_id: string;
    transition_count: number;
  }>;
}

// --- deal-velocity ---------------------------------------------------------

export interface DealVelocityStage {
  stage_id: string;
  stage_name: string;
  sort_order: number;
  avg_duration_seconds: number;
  sample_count: number;
  avg_duration_days: number | null;
}

export interface DealVelocityResponse {
  stage_velocity: DealVelocityStage[];
  avg_cycle_days: number | null;
  closed_deal_count: number;
}

// --- forecast --------------------------------------------------------------

export interface ForecastResponse {
  total_weighted_value: number;
  deal_count: number;
  buckets: {
    next_30: number;
    next_60: number;
    next_90: number;
    beyond: number;
    no_date: number;
  };
}

// --- stale-deals -----------------------------------------------------------

export interface StaleDeal {
  deal_id: string;
  deal_name: string;
  value: number | null;
  owner_id: string | null;
  stage_name: string;
  days_in_stage: number;
  rotting_days_threshold: number;
  last_activity_at: string | null;
}

export interface StaleDealsResponse {
  stale_deals: StaleDeal[];
  count: number;
}

// --- win-loss --------------------------------------------------------------

export interface WinLossStats {
  total_closed: number;
  won_count: number;
  lost_count: number;
  win_rate_pct: number;
  won_value: number;
  lost_value: number;
  loss_reasons: Array<{ reason: string; count: number }>;
  competitors: Array<{ name: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Query hooks
//
// deal-velocity and conversion-rates require a pipeline_id server-side
// (apps/bond-api/src/routes/analytics.routes.ts declares it as a required
// uuid). The page may not always have a pipeline selected, so those two
// hooks are gated with `enabled: !!pipelineId` to avoid firing a guaranteed
// 400. The other four endpoints accept an optional pipeline_id and run
// unconditionally.
// ---------------------------------------------------------------------------

export function usePipelineSummary(pipelineId?: string) {
  return useQuery({
    queryKey: ['bond', 'analytics', 'pipeline-summary', pipelineId],
    queryFn: () =>
      api.get<{ data: PipelineSummary }>('/analytics/pipeline-summary', {
        pipeline_id: pipelineId,
      }),
    staleTime: 30_000,
  });
}

export function useConversionRates(pipelineId?: string) {
  return useQuery({
    queryKey: ['bond', 'analytics', 'conversion-rates', pipelineId],
    queryFn: () =>
      api.get<{ data: ConversionRatesResponse }>('/analytics/conversion-rates', {
        pipeline_id: pipelineId,
      }),
    enabled: !!pipelineId,
    staleTime: 60_000,
  });
}

export function useDealVelocity(pipelineId?: string) {
  return useQuery({
    queryKey: ['bond', 'analytics', 'deal-velocity', pipelineId],
    queryFn: () =>
      api.get<{ data: DealVelocityResponse }>('/analytics/deal-velocity', {
        pipeline_id: pipelineId,
      }),
    enabled: !!pipelineId,
    staleTime: 60_000,
  });
}

export function useWinLossStats(pipelineId?: string) {
  return useQuery({
    queryKey: ['bond', 'analytics', 'win-loss', pipelineId],
    queryFn: () =>
      api.get<{ data: WinLossStats }>('/analytics/win-loss', {
        pipeline_id: pipelineId,
      }),
    staleTime: 60_000,
  });
}

export function useForecast(pipelineId?: string) {
  return useQuery({
    queryKey: ['bond', 'analytics', 'forecast', pipelineId],
    queryFn: () =>
      api.get<{ data: ForecastResponse }>('/analytics/forecast', {
        pipeline_id: pipelineId,
      }),
    staleTime: 60_000,
  });
}

export function useStaleDeals(pipelineId?: string) {
  return useQuery({
    queryKey: ['bond', 'analytics', 'stale-deals', pipelineId],
    queryFn: () =>
      api.get<{ data: StaleDealsResponse }>('/analytics/stale-deals', {
        pipeline_id: pipelineId,
      }),
    staleTime: 30_000,
  });
}
