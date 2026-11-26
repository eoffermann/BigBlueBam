import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BeaconStatus } from '@/hooks/use-beacons';

// ── Graph API types (§5.5.3) ────────────────────────────────────────

export interface GraphNode {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: BeaconStatus;
  tags: string[];
  verification_count: number;
  inbound_link_count: number;
  expires_at: string | null;
  last_verified_at: string | null;
  owned_by: string;
  owner_name?: string;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  edge_type: 'explicit' | 'implicit';
  link_type?: 'RelatedTo' | 'Supersedes' | 'DependsOn' | 'ConflictsWith' | 'SeeAlso';
  shared_tags?: string[];
  shared_tag_count?: number;
}

export interface GraphNeighborsResponse {
  focal_beacon_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphHubsResponse {
  data: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphRecentResponse {
  data: GraphNode[];
}

// ── Query hooks ─────────────────────────────────────────────────────

export function useGraphNeighbors(
  beaconId: string | undefined,
  hops = 1,
  options?: {
    includeImplicit?: boolean;
    tagAffinityThreshold?: number;
    statusFilters?: string[];
    enabled?: boolean;
  },
) {
  return useQuery({
    queryKey: ['graph-neighbors', beaconId, hops, options],
    queryFn: () =>
      api.get<GraphNeighborsResponse>('/graph/neighbors', {
        beacon_id: beaconId,
        hops,
        include_implicit: options?.includeImplicit ?? true,
        tag_affinity_threshold: options?.tagAffinityThreshold ?? 2,
        'filters.status': options?.statusFilters?.join(','),
      }),
    enabled: !!beaconId && (options?.enabled !== false),
    staleTime: 60_000,
  });
}

export function useGraphHubs(
  scope: 'project' | 'organization' = 'organization',
  projectId?: string,
  topK = 20,
) {
  return useQuery({
    queryKey: ['graph-hubs', scope, projectId, topK],
    queryFn: () =>
      api.get<GraphHubsResponse>('/graph/hubs', {
        scope,
        project_id: projectId,
        top_k: topK,
      }),
    staleTime: 120_000,
  });
}

export function useGraphRecent(
  scope: 'project' | 'organization' = 'organization',
  projectId?: string,
  days = 7,
) {
  return useQuery({
    queryKey: ['graph-recent', scope, projectId, days],
    queryFn: () =>
      api.get<GraphRecentResponse>('/graph/recent', {
        scope,
        project_id: projectId,
        days,
      }),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
