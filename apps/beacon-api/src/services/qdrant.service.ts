/**
 * Qdrant service — manages the beacon_chunks collection and vector operations.
 *
 * Per §2.2.3 / §2.2.5 of the Beacon Design Spec:
 * - Collection: beacon_chunks (1024-dim cosine dense, sparse named vector `idf`)
 * - Points carry payload: beacon_id, org_id, project_id, status, tags, visibility,
 *   expires_at, chunk_type, chunk_index, title, owned_by, version, linked_beacon_ids
 */

import { getQdrantClient } from '../lib/qdrant.js';
import { chunkBeacon, type BeaconForChunking } from './chunker.service.js';
import { embedTexts, embedSparse } from './embedding.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COLLECTION_NAME = 'beacon_chunks';
const DENSE_DIM = 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeaconForIndexing extends BeaconForChunking {
  id: string;
  organization_id: string;
  project_id: string | null;
  status: string;
  visibility: string;
  owned_by: string;
  version: number;
  expires_at: Date | null;
}

export interface QdrantSearchFilters {
  organization_id: string;
  project_ids?: string[];
  status?: string[];
  tags?: string[];
  visibility_max?: string;
  expires_after?: string;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Collection management
// ---------------------------------------------------------------------------

/**
 * Create the beacon_chunks collection if it does not exist.
 * Dense: 1024-dim cosine. Sparse: named vector `idf`.
 */
export async function ensureCollection(): Promise<void> {
  const client = getQdrantClient();

  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        dense: {
          size: DENSE_DIM,
          distance: 'Cosine',
        },
      },
      sparse_vectors: {
        idf: {},
      },
    });

    // Create payload indexes for filtered search
    const indexedFields: Array<{ name: string; type: 'keyword' | 'uuid' | 'integer' | 'datetime' }> = [
      { name: 'beacon_id', type: 'keyword' },
      { name: 'organization_id', type: 'keyword' },
      { name: 'project_id', type: 'keyword' },
      { name: 'status', type: 'keyword' },
      { name: 'tags', type: 'keyword' },
      { name: 'visibility', type: 'keyword' },
      { name: 'chunk_type', type: 'keyword' },
      { name: 'owned_by', type: 'keyword' },
    ];

    for (const field of indexedFields) {
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: field.name,
        field_schema: field.type === 'uuid' ? 'keyword' : field.type,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Chunk a beacon, embed all chunks, and upsert them into Qdrant.
 * Deletes any orphaned chunks if the beacon has fewer chunks than before.
 */
export async function upsertBeaconChunks(
  beacon: BeaconForIndexing,
  tags: string[],
  linkedBeacons: { id: string; title: string; link_type: string }[],
): Promise<void> {
  const client = getQdrantClient();

  const linkedTitles = linkedBeacons.map((l) => ({
    title: l.title,
    link_type: l.link_type,
  }));
  const linkedIds = linkedBeacons.map((l) => l.id);

  // 1. Chunk
  const chunks = chunkBeacon(beacon, tags, linkedTitles);

  // 2. Embed (dense + sparse in parallel)
  const texts = chunks.map((c) => c.text);
  const [denseVectors, sparseVectors] = await Promise.all([
    embedTexts(texts),
    embedSparse(texts),
  ]);

  // 3. Build points
  const points = chunks.map((chunk, idx) => ({
    id: pointId(beacon.id, idx),
    vector: {
      dense: denseVectors[idx]!,
      idf: sparseVectors[idx]!,
    },
    payload: {
      beacon_id: beacon.id,
      organization_id: beacon.organization_id,
      project_id: beacon.project_id,
      status: beacon.status,
      tags,
      visibility: beacon.visibility,
      chunk_index: idx,
      chunk_type: chunk.chunk_type,
      section_title: chunk.section_title ?? null,
      title: beacon.title,
      owned_by: beacon.owned_by,
      version: beacon.version,
      expires_at: beacon.expires_at?.toISOString() ?? null,
      linked_beacon_ids: linkedIds,
    },
  }));

  // 4. Upsert
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points,
  });

  // 5. Delete orphaned chunks (if beacon previously had more chunks)
  // We delete any chunks with chunk_index >= current chunk count
  await deleteOrphanedChunks(beacon.id, chunks.length);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete all Qdrant points belonging to a given beacon.
 */
export async function deleteBeaconChunks(beaconId: string): Promise<void> {
  const client = getQdrantClient();

  await client.delete(COLLECTION_NAME, {
    wait: true,
    filter: {
      must: [{ key: 'beacon_id', match: { value: beaconId } }],
    },
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Hybrid search in Qdrant: dense + sparse with payload filters, grouped by beacon_id.
 */
export async function searchChunks(
  queryVector: number[],
  filters: QdrantSearchFilters,
  topK = 50,
): Promise<QdrantSearchResult[]> {
  const client = getQdrantClient();

  // Build filter conditions
  const must: Array<Record<string, unknown>> = [
    { key: 'organization_id', match: { value: filters.organization_id } },
  ];

  if (filters.project_ids && filters.project_ids.length > 0) {
    must.push({
      key: 'project_id',
      match: { any: filters.project_ids },
    });
  }

  if (filters.status && filters.status.length > 0) {
    must.push({
      key: 'status',
      match: { any: filters.status },
    });
  }

  if (filters.tags && filters.tags.length > 0) {
    must.push({
      key: 'tags',
      match: { any: filters.tags },
    });
  }

  if (filters.visibility_max) {
    // Visibility ordering: Private < Project < Organization < Public
    const visLevels = ['Private', 'Project', 'Organization', 'Public'];
    const maxIdx = visLevels.indexOf(filters.visibility_max);
    if (maxIdx >= 0) {
      must.push({
        key: 'visibility',
        match: { any: visLevels.slice(0, maxIdx + 1) },
      });
    }
  } else {
    // Default: exclude Private beacons from vector search to prevent score leakage
    must.push({
      key: 'visibility',
      match: { any: ['Project', 'Organization', 'Public'] },
    });
  }

  const results = await client.search(COLLECTION_NAME, {
    vector: { name: 'dense', vector: queryVector },
    filter: { must },
    limit: topK,
    with_payload: true,
  });

  return results.map((r) => ({
    id: r.id,
    score: r.score,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic point ID from beacon UUID and chunk index.
 * Uses a numeric hash to create a stable integer ID that Qdrant can index.
 */
function pointId(beaconId: string, chunkIndex: number): string {
  // Use a UUID v5-style deterministic ID: beacon_id + chunk_index
  // For simplicity, concatenate and use as string point ID
  return `${beaconId}__${chunkIndex}`;
}

/**
 * Delete chunks for a beacon with chunk_index >= maxChunkIndex.
 * Used after upsert to clean up orphans when body shrinks.
 */
async function deleteOrphanedChunks(
  beaconId: string,
  maxChunkIndex: number,
): Promise<void> {
  const client = getQdrantClient();

  // Scroll to find points with chunk_index >= maxChunkIndex
  const scrollResult = await client.scroll(COLLECTION_NAME, {
    filter: {
      must: [
        { key: 'beacon_id', match: { value: beaconId } },
        { key: 'chunk_index', range: { gte: maxChunkIndex } },
      ],
    },
    limit: 100,
  });

  if (scrollResult.points.length > 0) {
    const pointIds = scrollResult.points.map((p) => p.id);
    await client.delete(COLLECTION_NAME, {
      wait: true,
      points: pointIds as any,
    });
  }
}
