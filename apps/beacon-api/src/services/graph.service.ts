/**
 * Graph service — BFS neighbor traversal, hub scoring, and recency queries
 * for the Knowledge Graph Explorer (§5.5.3).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import type Redis from 'ioredis';

/** Convert a JS string array to a sql`IN (...)` fragment safe for Drizzle. */
function sqlInList(arr: string[]) {
  return sql.join(arr.map((v) => sql`${v}`), sql`, `);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  status: string;
  tags: string[];
  verification_count: number;
  inbound_link_count: number;
  expires_at: string | null;
  last_verified_at: string | null;
  owned_by: string;
  owner_name: string | null;
}

export interface ExplicitEdge {
  source_id: string;
  target_id: string;
  edge_type: 'explicit';
  link_type: string;
}

export interface ImplicitEdge {
  source_id: string;
  target_id: string;
  edge_type: 'implicit';
  shared_tags: string[];
  shared_tag_count: number;
}

export type GraphEdge = ExplicitEdge | ImplicitEdge;

export interface NeighborResult {
  focal_beacon_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Redis cache helper (lazy singleton — set by route registration)
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;

export function setRedis(redis: Redis) {
  _redis = redis;
}

const IMPLICIT_TTL = 600; // 10 minutes

// ---------------------------------------------------------------------------
// getNeighbors — BFS up to N hops
// ---------------------------------------------------------------------------

export async function getNeighbors(
  beaconId: string,
  hops: number,
  includeImplicit: boolean,
  tagAffinityThreshold: number,
  statusFilter: string[],
  orgId: string,
  userId: string,
): Promise<NeighborResult> {
  // BFS: collect node IDs layer by layer
  const visited = new Set<string>([beaconId]);
  let frontier = [beaconId];
  const allExplicitEdges: ExplicitEdge[] = [];

  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    // Fetch explicit edges for current frontier
    const rows: any[] = await db.execute(sql`
      SELECT bl.source_id, bl.target_id, bl.link_type
      FROM beacon_links bl
      JOIN beacon_entries be_src ON be_src.id = bl.source_id
      JOIN beacon_entries be_tgt ON be_tgt.id = bl.target_id
      WHERE (bl.source_id IN (${sqlInList(frontier)}) OR bl.target_id IN (${sqlInList(frontier)}))
        AND be_src.status IN (${sqlInList(statusFilter)})
        AND be_tgt.status IN (${sqlInList(statusFilter)})
        AND be_src.organization_id = ${orgId}
        AND be_tgt.organization_id = ${orgId}
    `);

    const nextFrontier: string[] = [];
    for (const row of rows) {
      const edge: ExplicitEdge = {
        source_id: row.source_id,
        target_id: row.target_id,
        edge_type: 'explicit',
        link_type: row.link_type,
      };
      allExplicitEdges.push(edge);

      for (const nid of [row.source_id, row.target_id]) {
        if (!visited.has(nid)) {
          visited.add(nid);
          nextFrontier.push(nid);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Implicit edges via tag affinity
  const allImplicitEdges: ImplicitEdge[] = [];
  if (includeImplicit) {
    const nodeIds = Array.from(visited);
    for (const nodeId of nodeIds) {
      const implicit = await getImplicitEdges(nodeId, tagAffinityThreshold, statusFilter, orgId);
      for (const edge of implicit) {
        // Only include edges where both ends are in our node set OR we add the new node
        visited.add(edge.source_id);
        visited.add(edge.target_id);
        allImplicitEdges.push(edge);
      }
    }
  }

  // Fetch full node data for all collected IDs
  const nodeIds = Array.from(visited);
  const nodes = await fetchNodes(nodeIds, statusFilter, orgId, userId);

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const e of allExplicitEdges) {
    const key = `explicit:${e.source_id}:${e.target_id}:${e.link_type}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push(e);
    }
  }
  for (const e of allImplicitEdges) {
    const key = `implicit:${[e.source_id, e.target_id].sort().join(':')}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push(e);
    }
  }

  return { focal_beacon_id: beaconId, nodes, edges };
}

// ---------------------------------------------------------------------------
// Implicit edges — self-join on beacon_tags, cached in Redis
// ---------------------------------------------------------------------------

async function getImplicitEdges(
  beaconId: string,
  threshold: number,
  statusFilter: string[],
  orgId: string,
): Promise<ImplicitEdge[]> {
  const cacheKey = `beacon:implicit:${beaconId}`;

  // Try Redis cache
  if (_redis) {
    try {
      const cached = await _redis.get(cacheKey);
      if (cached) {
        const parsed: ImplicitEdge[] = JSON.parse(cached);
        return parsed.filter((e) => e.shared_tag_count >= threshold);
      }
    } catch {
      // Cache miss — fall through to DB
    }
  }

  // SQL self-join: find beacons sharing tags with beaconId
  const rows: any[] = await db.execute(sql`
    SELECT
      t1.beacon_id AS source_id,
      t2.beacon_id AS target_id,
      ARRAY_AGG(t1.tag) AS shared_tags,
      COUNT(*)::int AS shared_tag_count
    FROM beacon_tags t1
    JOIN beacon_tags t2 ON t1.tag = t2.tag AND t1.beacon_id <> t2.beacon_id
    JOIN beacon_entries be ON be.id = t2.beacon_id
    WHERE t1.beacon_id = ${beaconId}
      AND be.status IN (${sqlInList(statusFilter)})
      AND be.organization_id = ${orgId}
    GROUP BY t1.beacon_id, t2.beacon_id
    HAVING COUNT(*) >= 2
  `);

  const edges: ImplicitEdge[] = rows.map((r) => ({
    source_id: r.source_id,
    target_id: r.target_id,
    edge_type: 'implicit' as const,
    shared_tags: r.shared_tags,
    shared_tag_count: r.shared_tag_count,
  }));

  // Cache all edges (with minimum threshold=2) in Redis
  if (_redis) {
    try {
      await _redis.setex(cacheKey, IMPLICIT_TTL, JSON.stringify(edges));
    } catch {
      // Best effort
    }
  }

  return edges.filter((e) => e.shared_tag_count >= threshold);
}

// ---------------------------------------------------------------------------
// fetchNodes — batch-load node details with inbound link counts
// ---------------------------------------------------------------------------

async function fetchNodes(
  nodeIds: string[],
  statusFilter: string[],
  orgId: string,
  userId?: string,
): Promise<GraphNode[]> {
  if (nodeIds.length === 0) return [];

  // Visibility filter: exclude Private beacons not owned by the requesting user,
  // and exclude Project-visibility beacons the user is not a member of.
  const visFilter = userId
    ? sql`AND (
        be.visibility = 'Organization'
        OR (be.visibility = 'Private' AND (be.owned_by = ${userId} OR be.created_by = ${userId}))
        OR (be.visibility = 'Project' AND (
          be.owned_by = ${userId}
          OR be.created_by = ${userId}
          OR be.project_id IN (SELECT pm.project_id FROM project_memberships pm WHERE pm.user_id = ${userId})
        ))
      )`
    : sql`AND be.visibility = 'Organization'`;

  const rows: any[] = await db.execute(sql`
    SELECT
      be.id,
      be.slug,
      be.title,
      be.summary,
      be.status,
      be.verification_count,
      be.expires_at,
      be.last_verified_at,
      be.owned_by,
      u.display_name AS owner_name,
      COALESCE(lc.cnt, 0)::int AS inbound_link_count,
      COALESCE(
        (SELECT ARRAY_AGG(bt.tag) FROM beacon_tags bt WHERE bt.beacon_id = be.id),
        '{}'
      ) AS tags
    FROM beacon_entries be
    LEFT JOIN users u ON u.id = be.owned_by
    LEFT JOIN (
      SELECT target_id, COUNT(*)::int AS cnt
      FROM beacon_links
      GROUP BY target_id
    ) lc ON lc.target_id = be.id
    WHERE be.id IN (${sqlInList(nodeIds)})
      AND be.status IN (${sqlInList(statusFilter)})
      AND be.organization_id = ${orgId}
      ${visFilter}
  `);

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    status: r.status,
    tags: r.tags ?? [],
    verification_count: r.verification_count,
    inbound_link_count: r.inbound_link_count,
    expires_at: r.expires_at?.toISOString?.() ?? r.expires_at ?? null,
    last_verified_at: r.last_verified_at?.toISOString?.() ?? r.last_verified_at ?? null,
    owned_by: r.owned_by,
    owner_name: r.owner_name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// getHubs — top-K beacons by (inbound link count + verification_count) DESC
// ---------------------------------------------------------------------------

export async function getHubs(
  scope: 'project' | 'organization',
  projectId: string | null,
  orgId: string,
  topK: number,
  userId?: string,
): Promise<{ nodes: GraphNode[]; edges: ExplicitEdge[] }> {
  const projectFilter =
    scope === 'project' && projectId
      ? sql`AND be.project_id = ${projectId}`
      : sql``;

  const visFilter = userId
    ? sql`AND (
        be.visibility = 'Organization'
        OR (be.visibility = 'Private' AND (be.owned_by = ${userId} OR be.created_by = ${userId}))
        OR (be.visibility = 'Project' AND (
          be.owned_by = ${userId}
          OR be.created_by = ${userId}
          OR be.project_id IN (SELECT pm.project_id FROM project_memberships pm WHERE pm.user_id = ${userId})
        ))
      )`
    : sql`AND be.visibility = 'Organization'`;

  const rows: any[] = await db.execute(sql`
    SELECT
      be.id,
      be.slug,
      be.title,
      be.summary,
      be.status,
      be.verification_count,
      be.expires_at,
      be.last_verified_at,
      be.owned_by,
      u.display_name AS owner_name,
      COALESCE(lc.cnt, 0)::int AS inbound_link_count,
      COALESCE(
        (SELECT ARRAY_AGG(bt.tag) FROM beacon_tags bt WHERE bt.beacon_id = be.id),
        '{}'
      ) AS tags
    FROM beacon_entries be
    LEFT JOIN users u ON u.id = be.owned_by
    LEFT JOIN (
      SELECT target_id, COUNT(*)::int AS cnt
      FROM beacon_links
      GROUP BY target_id
    ) lc ON lc.target_id = be.id
    WHERE be.status IN ('Active', 'PendingReview')
      AND be.organization_id = ${orgId}
      ${projectFilter}
      ${visFilter}
    ORDER BY (COALESCE(lc.cnt, 0) + be.verification_count) DESC
    LIMIT ${topK}
  `);

  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    status: r.status,
    tags: r.tags ?? [],
    verification_count: r.verification_count,
    inbound_link_count: r.inbound_link_count,
    expires_at: r.expires_at?.toISOString?.() ?? r.expires_at ?? null,
    last_verified_at: r.last_verified_at?.toISOString?.() ?? r.last_verified_at ?? null,
    owned_by: r.owned_by,
    owner_name: r.owner_name ?? null,
  }));

  // Fetch explicit edges between hub nodes so the graph canvas can draw connections
  const nodeIds = nodes.map((n) => n.id);
  const edges: ExplicitEdge[] = [];
  if (nodeIds.length > 1) {
    const edgeRows: any[] = await db.execute(sql`
      SELECT source_id, target_id, link_type
      FROM beacon_links
      WHERE source_id IN (${sqlInList(nodeIds)})
        AND target_id IN (${sqlInList(nodeIds)})
    `);
    for (const row of edgeRows) {
      edges.push({
        source_id: row.source_id,
        target_id: row.target_id,
        edge_type: 'explicit',
        link_type: row.link_type,
      });
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// getRecent — beacons updated or verified in the last N days
// ---------------------------------------------------------------------------

export async function getRecent(
  scope: 'project' | 'organization',
  projectId: string | null,
  orgId: string,
  days: number,
  userId?: string,
): Promise<GraphNode[]> {
  const projectFilter =
    scope === 'project' && projectId
      ? sql`AND be.project_id = ${projectId}`
      : sql``;

  const visFilter = userId
    ? sql`AND (
        be.visibility = 'Organization'
        OR (be.visibility = 'Private' AND (be.owned_by = ${userId} OR be.created_by = ${userId}))
        OR (be.visibility = 'Project' AND (
          be.owned_by = ${userId}
          OR be.created_by = ${userId}
          OR be.project_id IN (SELECT pm.project_id FROM project_memberships pm WHERE pm.user_id = ${userId})
        ))
      )`
    : sql`AND be.visibility = 'Organization'`;

  const rows: any[] = await db.execute(sql`
    SELECT
      be.id,
      be.slug,
      be.title,
      be.summary,
      be.status,
      be.verification_count,
      be.expires_at,
      be.last_verified_at,
      be.owned_by,
      u.display_name AS owner_name,
      COALESCE(lc.cnt, 0)::int AS inbound_link_count,
      COALESCE(
        (SELECT ARRAY_AGG(bt.tag) FROM beacon_tags bt WHERE bt.beacon_id = be.id),
        '{}'
      ) AS tags
    FROM beacon_entries be
    LEFT JOIN users u ON u.id = be.owned_by
    LEFT JOIN (
      SELECT target_id, COUNT(*)::int AS cnt
      FROM beacon_links
      GROUP BY target_id
    ) lc ON lc.target_id = be.id
    WHERE be.status IN ('Active', 'PendingReview')
      AND be.organization_id = ${orgId}
      ${projectFilter}
      ${visFilter}
      AND (
        be.updated_at > NOW() - MAKE_INTERVAL(days => ${days})
        OR be.last_verified_at > NOW() - MAKE_INTERVAL(days => ${days})
      )
    ORDER BY GREATEST(be.updated_at, COALESCE(be.last_verified_at, be.updated_at)) DESC
  `);

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    status: r.status,
    tags: r.tags ?? [],
    verification_count: r.verification_count,
    inbound_link_count: r.inbound_link_count,
    expires_at: r.expires_at?.toISOString?.() ?? r.expires_at ?? null,
    last_verified_at: r.last_verified_at?.toISOString?.() ?? r.last_verified_at ?? null,
    owned_by: r.owned_by,
    owner_name: r.owner_name ?? null,
  }));
}
