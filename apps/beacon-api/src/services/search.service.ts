/**
 * Search service — multi-signal retrieval with re-ranking.
 *
 * Per §2.2.6 of the Beacon Design Spec:
 * - Stage 1 (parallel): (a) Qdrant hybrid search, (d) PostgreSQL fulltext fallback
 * - (b) Tag expansion: find beacons sharing >= 2 tags with top results
 * - (c) Link traversal: follow beacon_links 1-hop from top results
 * - Deduplicate to beacon-level
 * - Stage 2: Re-rank with freshness decay and authority boost
 * - Format response per §5.3
 */

import { eq, and, or, inArray, ilike } from 'drizzle-orm';
import { escapeLike } from './beacon.service.js';
import { db } from '../db/index.js';
import {
  beaconEntries,
  beaconTags,
  beaconLinks,
  projectMemberships,
} from '../db/schema/index.js';
import { searchChunks, type QdrantSearchFilters } from './qdrant.service.js';
import { embedTexts } from './embedding.service.js';

// ---------------------------------------------------------------------------
// Types — aligned with §5.2 / §5.3
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  filters: {
    organization_id: string;
    project_ids?: string[];
    status?: string[];
    tags?: string[];
    visibility_max?: string;
    expires_after?: string;
  };
  options?: {
    include_graph_expansion?: boolean;
    include_tag_expansion?: boolean;
    include_fulltext_fallback?: boolean;
    rerank?: boolean;
    top_k?: number;
    group_by_beacon?: boolean;
  };
}

export interface SearchResultItem {
  beacon_id: string;
  slug: string;
  title: string;
  summary: string | null;
  status: string;
  relevance_score: number;
  match_sources: string[];
  expires_at: string | null;
  last_verified_at: string | null;
  verification_count: number;
  tags: string[];
  linked_beacons: { id: string; title: string; link_type: string }[];
  highlight: string | null;
}

export interface SearchResponse {
  results: SearchResultItem[];
  total_candidates: number;
  retrieval_stages: {
    semantic_hits: number;
    tag_expansion_hits: number;
    link_traversal_hits: number;
    fulltext_fallback_hits: number;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hybrid multi-signal search with re-ranking.
 * Supports top_k: 0 for count-only mode (live query preview).
 */
export async function hybridSearch(
  request: SearchRequest,
  userId: string,
): Promise<SearchResponse> {
  const opts = {
    include_graph_expansion: true,
    include_tag_expansion: true,
    include_fulltext_fallback: true,
    rerank: true,
    top_k: 10,
    group_by_beacon: true,
    ...request.options,
  };

  const stages = {
    semantic_hits: 0,
    tag_expansion_hits: 0,
    link_traversal_hits: 0,
    fulltext_fallback_hits: 0,
  };

  // Candidate map: beacon_id -> { score, sources }
  const candidates = new Map<
    string,
    { score: number; sources: Set<string> }
  >();

  // -----------------------------------------------------------------------
  // Stage 1: Parallel candidate retrieval
  // -----------------------------------------------------------------------

  const stage1Promises: Promise<void>[] = [];

  // (a) Qdrant hybrid search (dense + sparse)
  stage1Promises.push(
    (async () => {
      try {
        const [queryVector] = await embedTexts([request.query]);
        const qdrantFilters: QdrantSearchFilters = {
          organization_id: request.filters.organization_id,
          project_ids: request.filters.project_ids,
          status: request.filters.status,
          tags: request.filters.tags,
          visibility_max: request.filters.visibility_max,
          expires_after: request.filters.expires_after,
        };

        const results = await searchChunks(queryVector!, qdrantFilters, 50);

        for (const r of results) {
          const beaconId = r.payload.beacon_id as string;
          stages.semantic_hits++;
          const existing = candidates.get(beaconId);
          if (existing) {
            existing.score = Math.max(existing.score, r.score);
            existing.sources.add('semantic');
          } else {
            candidates.set(beaconId, {
              score: r.score,
              sources: new Set(['semantic']),
            });
          }
        }
      } catch (err) {
        // Qdrant unavailable — degrade gracefully
        console.warn('Qdrant search failed, falling back to fulltext only:', (err as Error).message);
      }
    })(),
  );

  // (d) PostgreSQL full-text fallback
  if (opts.include_fulltext_fallback) {
    stage1Promises.push(
      (async () => {
        try {
          const ftResults = await fulltextSearch(
            request.query,
            request.filters.organization_id,
            request.filters.project_ids,
            request.filters.status,
          );
          for (const r of ftResults) {
            stages.fulltext_fallback_hits++;
            const existing = candidates.get(r.id);
            if (existing) {
              existing.sources.add('fulltext');
            } else {
              candidates.set(r.id, {
                score: 0.5, // base score for fulltext matches
                sources: new Set(['fulltext']),
              });
            }
          }
        } catch (err) {
          console.warn('Fulltext search failed:', (err as Error).message);
        }
      })(),
    );
  }

  await Promise.all(stage1Promises);

  // -----------------------------------------------------------------------
  // (b) Tag expansion: find beacons sharing >= 2 tags with top results
  // -----------------------------------------------------------------------

  if (opts.include_tag_expansion && candidates.size > 0) {
    try {
      const topBeaconIds = getTopBeaconIds(candidates, 10);
      const tagExpansionIds = await tagExpansionSearch(
        topBeaconIds,
        request.filters.organization_id,
      );
      for (const id of tagExpansionIds) {
        stages.tag_expansion_hits++;
        const existing = candidates.get(id);
        if (existing) {
          existing.sources.add('tag_expansion');
        } else {
          candidates.set(id, {
            score: 0.4,
            sources: new Set(['tag_expansion']),
          });
        }
      }
    } catch (err) {
      console.warn('Tag expansion failed:', (err as Error).message);
    }
  }

  // -----------------------------------------------------------------------
  // (c) Link traversal: follow beacon_links 1-hop from top results
  // -----------------------------------------------------------------------

  if (opts.include_graph_expansion && candidates.size > 0) {
    try {
      const topBeaconIds = getTopBeaconIds(candidates, 10);
      const linkedIds = await linkTraversalSearch(topBeaconIds, request.filters.organization_id);
      for (const id of linkedIds) {
        stages.link_traversal_hits++;
        const existing = candidates.get(id);
        if (existing) {
          existing.sources.add('link_traversal');
        } else {
          candidates.set(id, {
            score: 0.35,
            sources: new Set(['link_traversal']),
          });
        }
      }
    } catch (err) {
      console.warn('Link traversal failed:', (err as Error).message);
    }
  }

  const totalCandidates = candidates.size;

  // Count-only mode
  if (opts.top_k === 0) {
    return {
      results: [],
      total_candidates: totalCandidates,
      retrieval_stages: stages,
    };
  }

  // -----------------------------------------------------------------------
  // Stage 2: Re-rank with freshness decay and authority boost
  // -----------------------------------------------------------------------

  if (candidates.size === 0) {
    return { results: [], total_candidates: 0, retrieval_stages: stages };
  }

  // Fetch full beacon data for all candidates, scoped to org
  const candidateIds = [...candidates.keys()];
  const allBeacons = await db
    .select()
    .from(beaconEntries)
    .where(
      and(
        inArray(beaconEntries.id, candidateIds),
        eq(beaconEntries.organization_id, request.filters.organization_id),
      ),
    );

  // Enforce visibility: filter out Private/Project beacons the user cannot see
  const userProjectRows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, userId));
  const userProjectIds = new Set(userProjectRows.map((r) => r.project_id));

  const beacons = allBeacons.filter((beacon) => {
    if (beacon.visibility === 'Private') {
      return beacon.owned_by === userId || beacon.created_by === userId;
    }
    if (beacon.visibility === 'Project' && beacon.project_id) {
      return (
        beacon.owned_by === userId ||
        beacon.created_by === userId ||
        userProjectIds.has(beacon.project_id)
      );
    }
    return true; // Public, Organization
  });

  // Fetch tags for all candidate beacons
  const allTags = await db
    .select()
    .from(beaconTags)
    .where(inArray(beaconTags.beacon_id, candidateIds));

  const tagsByBeacon = new Map<string, string[]>();
  for (const t of allTags) {
    const existing = tagsByBeacon.get(t.beacon_id) ?? [];
    existing.push(t.tag);
    tagsByBeacon.set(t.beacon_id, existing);
  }

  // Fetch links for all candidate beacons
  const allLinks = await db
    .select({
      source_id: beaconLinks.source_id,
      target_id: beaconLinks.target_id,
      link_type: beaconLinks.link_type,
    })
    .from(beaconLinks)
    .where(
      or(
        inArray(beaconLinks.source_id, candidateIds),
        inArray(beaconLinks.target_id, candidateIds),
      ),
    );

  // Build linked beacons map
  const linkedByBeacon = new Map<string, { id: string; link_type: string }[]>();
  for (const link of allLinks) {
    // Add link in both directions
    for (const [from, to] of [
      [link.source_id, link.target_id],
      [link.target_id, link.source_id],
    ] as [string, string][]) {
      if (candidateIds.includes(from)) {
        const list = linkedByBeacon.get(from) ?? [];
        list.push({ id: to, link_type: link.link_type });
        linkedByBeacon.set(from, list);
      }
    }
  }

  // Look up titles for linked beacons
  const linkedBeaconIds = new Set<string>();
  for (const links of linkedByBeacon.values()) {
    for (const link of links) linkedBeaconIds.add(link.id);
  }
  const linkedBeaconTitles = new Map<string, string>();
  if (linkedBeaconIds.size > 0) {
    const linkedBeacons = await db
      .select({ id: beaconEntries.id, title: beaconEntries.title })
      .from(beaconEntries)
      .where(inArray(beaconEntries.id, [...linkedBeaconIds]));
    for (const b of linkedBeacons) {
      linkedBeaconTitles.set(b.id, b.title);
    }
  }

  // Score and rank
  const scoredResults: SearchResultItem[] = beacons.map((beacon) => {
    const candidate = candidates.get(beacon.id)!;
    let score = candidate.score;

    // Freshness decay: 1.0 - (days_since_verified / expiry_window) * 0.15, clamped [0.85, 1.0]
    if (opts.rerank && beacon.last_verified_at && beacon.expires_at) {
      const now = Date.now();
      const verifiedAt = beacon.last_verified_at.getTime();
      const expiresAt = beacon.expires_at.getTime();
      const expiryWindow = Math.max(expiresAt - verifiedAt, 1);
      const daysSinceVerified = (now - verifiedAt) / (1000 * 60 * 60 * 24);
      const expiryWindowDays = expiryWindow / (1000 * 60 * 60 * 24);
      const freshness = Math.max(
        0.85,
        Math.min(1.0, 1.0 - (daysSinceVerified / expiryWindowDays) * 0.15),
      );
      score *= freshness;
    }

    // Authority boost: small boost for verification count and link in-degree
    if (opts.rerank) {
      const verificationBoost = Math.min(beacon.verification_count * 0.02, 0.1);
      const linkCount = (linkedByBeacon.get(beacon.id) ?? []).length;
      const linkBoost = Math.min(linkCount * 0.01, 0.05);
      score += verificationBoost + linkBoost;
    }

    const beaconTags = tagsByBeacon.get(beacon.id) ?? [];
    const beaconLinks = (linkedByBeacon.get(beacon.id) ?? []).map((l) => ({
      id: l.id,
      title: linkedBeaconTitles.get(l.id) ?? 'Unknown',
      link_type: l.link_type,
    }));

    return {
      beacon_id: beacon.id,
      slug: beacon.slug,
      title: beacon.title,
      summary: beacon.summary,
      status: beacon.status,
      relevance_score: Math.round(score * 100) / 100,
      match_sources: [...candidate.sources],
      expires_at: beacon.expires_at?.toISOString() ?? null,
      last_verified_at: beacon.last_verified_at?.toISOString() ?? null,
      verification_count: beacon.verification_count,
      tags: beaconTags,
      linked_beacons: beaconLinks,
      highlight: null, // TODO: implement snippet highlighting
    };
  });

  // Sort by relevance_score descending
  scoredResults.sort((a, b) => b.relevance_score - a.relevance_score);

  return {
    results: scoredResults.slice(0, opts.top_k),
    total_candidates: totalCandidates,
    retrieval_stages: stages,
  };
}

/**
 * Simple typeahead suggestion — ILIKE on title + tags.
 */
export async function suggestBeacons(
  query: string,
  orgId: string,
  limit = 10,
  userId?: string,
): Promise<{ id: string; slug: string; title: string; tags: string[] }[]> {
  const pattern = `%${escapeLike(query)}%`;

  // Search by title
  const titleMatches = await db
    .select({
      id: beaconEntries.id,
      slug: beaconEntries.slug,
      title: beaconEntries.title,
      visibility: beaconEntries.visibility,
      project_id: beaconEntries.project_id,
      owned_by: beaconEntries.owned_by,
      created_by: beaconEntries.created_by,
    })
    .from(beaconEntries)
    .where(
      and(
        eq(beaconEntries.organization_id, orgId),
        ilike(beaconEntries.title, pattern),
      ),
    )
    .limit(limit * 2); // fetch extra to allow for visibility filtering

  // Search by tag
  const tagMatches = await db
    .select({
      id: beaconEntries.id,
      slug: beaconEntries.slug,
      title: beaconEntries.title,
      visibility: beaconEntries.visibility,
      project_id: beaconEntries.project_id,
      owned_by: beaconEntries.owned_by,
      created_by: beaconEntries.created_by,
    })
    .from(beaconEntries)
    .innerJoin(beaconTags, eq(beaconTags.beacon_id, beaconEntries.id))
    .where(
      and(
        eq(beaconEntries.organization_id, orgId),
        ilike(beaconTags.tag, pattern),
      ),
    )
    .limit(limit * 2);

  // Visibility filtering: get user's project memberships
  let suggestUserProjectIds: Set<string> | null = null;
  if (userId) {
    const projRows = await db
      .select({ project_id: projectMemberships.project_id })
      .from(projectMemberships)
      .where(eq(projectMemberships.user_id, userId));
    suggestUserProjectIds = new Set(projRows.map((r) => r.project_id));
  }

  // Deduplicate and filter by visibility
  const seen = new Set<string>();
  const results: { id: string; slug: string; title: string; tags: string[] }[] = [];

  for (const match of [...titleMatches, ...tagMatches]) {
    if (seen.has(match.id)) continue;
    seen.add(match.id);

    // Enforce visibility rules
    if (userId) {
      if (match.visibility === 'Private') {
        if (match.owned_by !== userId && match.created_by !== userId) continue;
      }
      if (match.visibility === 'Project' && match.project_id) {
        if (
          match.owned_by !== userId &&
          match.created_by !== userId &&
          !suggestUserProjectIds?.has(match.project_id)
        ) {
          continue;
        }
      }
    }

    results.push({ id: match.id, slug: match.slug, title: match.title, tags: [] });
  }

  // Fetch tags for results
  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    const tags = await db
      .select()
      .from(beaconTags)
      .where(inArray(beaconTags.beacon_id, ids));

    const tagMap = new Map<string, string[]>();
    for (const t of tags) {
      const list = tagMap.get(t.beacon_id) ?? [];
      list.push(t.tag);
      tagMap.set(t.beacon_id, list);
    }

    for (const r of results) {
      r.tags = tagMap.get(r.id) ?? [];
    }
  }

  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Get the top N beacon IDs by score from the candidate map.
 */
function getTopBeaconIds(
  candidates: Map<string, { score: number; sources: Set<string> }>,
  n: number,
): string[] {
  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, n)
    .map(([id]) => id);
}

/**
 * PostgreSQL full-text search fallback using ILIKE on title and summary.
 */
async function fulltextSearch(
  query: string,
  orgId: string,
  projectIds?: string[],
  status?: string[],
): Promise<{ id: string }[]> {
  const conditions = [
    eq(beaconEntries.organization_id, orgId),
    or(
      ilike(beaconEntries.title, `%${escapeLike(query)}%`),
      ilike(beaconEntries.summary, `%${escapeLike(query)}%`),
    )!,
  ];

  if (projectIds && projectIds.length > 0) {
    conditions.push(inArray(beaconEntries.project_id, projectIds));
  }

  if (status && status.length > 0) {
    conditions.push(inArray(beaconEntries.status, status as any));
  }

  return db
    .select({ id: beaconEntries.id })
    .from(beaconEntries)
    .where(and(...conditions))
    .limit(50);
}

/**
 * Tag expansion: find beacons that share >= 2 tags with any of the given beacon IDs.
 * Returns beacon IDs not already in the input set.
 */
export async function tagExpansionSearch(
  beaconIds: string[],
  orgId: string,
): Promise<string[]> {
  if (beaconIds.length === 0) return [];

  // Get all tags for the input beacons
  const sourceTags = await db
    .select({ tag: beaconTags.tag })
    .from(beaconTags)
    .where(inArray(beaconTags.beacon_id, beaconIds));

  const tagSet = [...new Set(sourceTags.map((t) => t.tag))];
  if (tagSet.length === 0) return [];

  // Find beacons with at least 2 matching tags (not in input set)
  const tagMatchRows = await db
    .select({
      beacon_id: beaconTags.beacon_id,
      tag: beaconTags.tag,
    })
    .from(beaconTags)
    .innerJoin(beaconEntries, eq(beaconEntries.id, beaconTags.beacon_id))
    .where(
      and(
        inArray(beaconTags.tag, tagSet),
        eq(beaconEntries.organization_id, orgId),
      ),
    );

  // Count tags per beacon
  const tagCounts = new Map<string, number>();
  for (const row of tagMatchRows) {
    if (beaconIds.includes(row.beacon_id)) continue; // skip input beacons
    tagCounts.set(row.beacon_id, (tagCounts.get(row.beacon_id) ?? 0) + 1);
  }

  // Return beacons with >= 2 shared tags
  return [...tagCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([id]) => id);
}

/**
 * Link traversal: follow beacon_links 1-hop from the given beacon IDs.
 * Returns linked beacon IDs not already in the input set.
 * Filters to beacons within the same organization to prevent cross-org data leakage.
 */
export async function linkTraversalSearch(beaconIds: string[], orgId: string): Promise<string[]> {
  if (beaconIds.length === 0) return [];

  // Join through beacon_entries to enforce organization_id filter on both ends
  // Source side: find targets linked from our beacons, where target is in same org
  const sourceLinks = await db
    .select({
      source_id: beaconLinks.source_id,
      target_id: beaconLinks.target_id,
    })
    .from(beaconLinks)
    .innerJoin(beaconEntries, eq(beaconEntries.id, beaconLinks.target_id))
    .where(
      and(
        inArray(beaconLinks.source_id, beaconIds),
        eq(beaconEntries.organization_id, orgId),
      ),
    );

  // Target side: find sources linked to our beacons, where source is in same org
  const targetLinks = await db
    .select({
      source_id: beaconLinks.source_id,
      target_id: beaconLinks.target_id,
    })
    .from(beaconLinks)
    .innerJoin(beaconEntries, eq(beaconEntries.id, beaconLinks.source_id))
    .where(
      and(
        inArray(beaconLinks.target_id, beaconIds),
        eq(beaconEntries.organization_id, orgId),
      ),
    );

  const inputSet = new Set(beaconIds);
  const linked = new Set<string>();

  for (const link of sourceLinks) {
    if (!inputSet.has(link.target_id)) linked.add(link.target_id);
  }
  for (const link of targetLinks) {
    if (!inputSet.has(link.source_id)) linked.add(link.source_id);
  }

  return [...linked];
}
