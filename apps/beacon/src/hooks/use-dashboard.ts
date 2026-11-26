import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Beacon, BeaconStatus } from './use-beacons';

// ── Types ────────────────────────────────────────────────────────────

interface PaginatedResponse<T> {
  data: T[];
  pagination?: {
    next_cursor?: string | null;
    has_more?: boolean;
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Active beacons expiring within the next N days (default 7).
 * The API only supports `expires_after`, so we fetch active beacons and
 * filter client-side for those whose expires_at is within the window.
 */
export function useAtRiskBeacons(days = 7) {
  const { data: allActive, isLoading, error } = useQuery({
    queryKey: ['beacons', 'active-for-risk'],
    queryFn: () =>
      api.get<PaginatedResponse<Beacon>>('/beacons', {
        status: 'Active' as BeaconStatus,
        limit: 500,
      }),
    select: (res) => res.data,
  });

  const atRisk = useMemo(() => {
    if (!allActive) return [];
    const now = Date.now();
    const cutoff = now + days * 86400000;
    return allActive
      .filter((b) => {
        if (!b.expires_at) return false;
        const exp = new Date(b.expires_at).getTime();
        return exp > now && exp <= cutoff;
      })
      .sort((a, b) => {
        const ae = a.expires_at ? new Date(a.expires_at).getTime() : Number.POSITIVE_INFINITY;
        const be = b.expires_at ? new Date(b.expires_at).getTime() : Number.POSITIVE_INFINITY;
        return ae - be;
      });
  }, [allActive, days]);

  return { data: atRisk, isLoading, error };
}

/** Archived beacons (candidates for cleanup). */
export function useArchivedBacklog() {
  return useQuery({
    queryKey: ['beacons', 'archived-backlog'],
    queryFn: () =>
      api.get<PaginatedResponse<Beacon>>('/beacons', {
        status: 'Archived' as BeaconStatus,
        limit: 100,
      }),
    select: (res) => res.data,
  });
}

/** All active beacons for computing freshness score and total count. */
export function useActiveBeacons() {
  return useQuery({
    queryKey: ['beacons', 'active-all'],
    queryFn: () =>
      api.get<PaginatedResponse<Beacon>>('/beacons', {
        status: 'Active' as BeaconStatus,
        limit: 500,
      }),
    select: (res) => res.data,
  });
}

/**
 * Compute the Freshness Score: % of Active beacons that have been
 * verified within the last 30 days.
 */
export function useFreshnessScore() {
  const { data: beacons, isLoading, error } = useActiveBeacons();

  const score = useMemo(() => {
    if (!beacons || beacons.length === 0) return { percent: 100, total: 0, fresh: 0 };

    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const fresh = beacons.filter((b) => {
      if (!b.last_verified_at) return false;
      return new Date(b.last_verified_at).getTime() > thirtyDaysAgo;
    }).length;

    return {
      percent: Math.round((fresh / beacons.length) * 100),
      total: beacons.length,
      fresh,
    };
  }, [beacons]);

  return { score, isLoading, error };
}

/**
 * Recent verification activity — beacons most recently verified,
 * sorted by last_verified_at descending. Used for the Agent Activity tab.
 */
export function useRecentVerifications() {
  return useQuery({
    queryKey: ['beacons', 'recent-verifications'],
    queryFn: async () => {
      const res = await api.get<PaginatedResponse<Beacon>>('/beacons', {
        status: 'Active' as BeaconStatus,
        limit: 50,
      });

      return res.data
        .filter((b) => b.last_verified_at)
        .sort((a, b) => {
          const at = a.last_verified_at ? new Date(a.last_verified_at).getTime() : 0;
          const bt = b.last_verified_at ? new Date(b.last_verified_at).getTime() : 0;
          return bt - at;
        })
        .slice(0, 20);
    },
  });
}
