/**
 * Basis certified-driver narrative generation (Basis design spec sections 2.4, 6).
 *
 * The deterministic explainer writes an explanation row with exact per-dimension
 * drivers but leaves `narrative` NULL. This job sweeps recent Class-A explanations
 * that still lack a narrative and asks the org's configured LLM (through the Bam
 * API's internal /internal/llm/chat proxy, which holds the encrypted keys) for a
 * short plain-language summary, then re-emits `metric.explanation_ready`.
 *
 * Only Class-A explanations get a narrative: Class-B breakdowns are per-viewer and
 * access-scoped, so a single shared narrative could leak restricted labels (spec
 * 2.4). If an org has no LLM provider configured the row is skipped (that is the
 * one genuinely-external dependency - see the HUMAN_SETUP doc); everything else
 * runs unattended. Each row is log-and-continue so one failure never stalls the
 * sweep, and the LLM prompt carries only the already-public Class-A labels and
 * magnitudes - never entity ids or amounts the viewer could not already see.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

export interface BasisExplainJobData {
  limit?: number;
}

interface Driver {
  dimension_value: string;
  label: string | null;
  contribution_abs: number;
  contribution_pct: number;
}

interface Row {
  cache_key: string;
  metric_id: string;
  organization_id: string;
  metric_name: string;
  unit: string;
  dimension: string | null;
  delta_abs: string | null;
  delta_pct: string | null;
  drivers: Driver[];
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// Resolve the org's effective LLM provider id directly (the worker has no session
// to use the cookie-auth /llm-providers/resolve route). Precedence: an org-scoped
// enabled provider (its default first), then a system-wide provider. Null if none.
async function resolveProviderId(
  db: ReturnType<typeof getDb>,
  orgId: string,
): Promise<string | null> {
  const found = rows<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM llm_providers
      WHERE enabled = true AND (organization_id = ${orgId} OR organization_id IS NULL)
      ORDER BY (organization_id = ${orgId}) DESC, is_default DESC
      LIMIT 1
    `),
  );
  return found[0]?.id ?? null;
}

async function generateNarrative(
  apiUrl: string,
  secret: string,
  providerId: string,
  row: Row,
): Promise<string | null> {
  const delta = row.delta_abs == null ? null : Number(row.delta_abs);
  const pct = row.delta_pct == null ? null : Number(row.delta_pct);
  const top = row.drivers
    .slice(0, 5)
    .map((d) => `${d.label ?? d.dimension_value}: ${d.contribution_abs >= 0 ? '+' : ''}${d.contribution_abs} (${Math.round(d.contribution_pct)}%)`)
    .join('; ');
  const facts = [
    `Metric: ${row.metric_name} (unit ${row.unit}).`,
    `Dimension: ${row.dimension ?? 'n/a'}.`,
    delta == null ? '' : `Total change: ${delta >= 0 ? '+' : ''}${delta}${pct == null ? '' : ` (${Math.round(pct)}%)`}.`,
    `Top contributions - ${top}.`,
  ].filter(Boolean).join(' ');

  const messages = [
    {
      role: 'system',
      content:
        'You explain why a business metric moved. Given the exact per-dimension contributions, write ONE or TWO plain, factual sentences naming the biggest drivers and their direction. Do not invent numbers, do not speculate about causes beyond the given contributions, and do not add a preamble.',
    },
    { role: 'user', content: facts },
  ];

  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/internal/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify({ provider_id: providerId, messages, max_tokens: 200, temperature: 0.2 }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 15000) + 5000),
  });
  if (!res.ok) throw new Error(`internal-llm ${res.status}`);
  const json = (await res.json()) as { data?: { content?: string } };
  const text = json.data?.content?.trim();
  return text ? text : null;
}

export async function processBasisExplainJob(
  job: Job<BasisExplainJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const limit = Math.min(job.data?.limit ?? 25, 100);
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://api:4000';
  const secret = process.env.INTERNAL_SERVICE_SECRET ?? '';
  const start = Date.now();

  if (!secret) {
    logger.warn('basis-explain: INTERNAL_SERVICE_SECRET not set, skipping');
    return;
  }

  // Recent Class-A explanations still missing a narrative, on certified metrics.
  const pending = rows<Row>(
    await db.execute(sql`
      SELECT e.cache_key, e.metric_id, e.organization_id, e.dimension,
             e.delta_abs, e.delta_pct, e.drivers,
             m.name AS metric_name, m.unit AS unit
      FROM basis_explanations e
      JOIN basis_metrics m ON m.id = e.metric_id AND m.certification = 'certified'
      WHERE e.narrative IS NULL
        AND e.dimension_class = 'A'
        AND e.computed_at > now() - interval '2 hours'
      ORDER BY e.computed_at DESC
      LIMIT ${limit}
    `),
  );

  // Cache provider resolution per org so a multi-row sweep does one lookup each.
  const providerByOrg = new Map<string, string | null>();
  let narrated = 0;
  let skippedNoProvider = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      if (!providerByOrg.has(row.organization_id)) {
        providerByOrg.set(row.organization_id, await resolveProviderId(db, row.organization_id));
      }
      const providerId = providerByOrg.get(row.organization_id) ?? null;
      if (!providerId) {
        skippedNoProvider++;
        continue; // org has no LLM provider (external setup); leave narrative null.
      }
      const narrative = await generateNarrative(apiUrl, secret, providerId, row);
      if (!narrative) {
        failed++;
        continue;
      }
      // Only set if still null (a concurrent read may have re-derived it).
      const updated = rows<{ cache_key: string }>(
        await db.execute(sql`
          UPDATE basis_explanations SET narrative = ${narrative}
          WHERE cache_key = ${row.cache_key} AND narrative IS NULL
          RETURNING cache_key
        `),
      );
      if (updated.length > 0) {
        narrated++;
        void publishBoltEvent(
          'metric.explanation_ready',
          'basis',
          { metric: { id: row.metric_id }, cache_key: row.cache_key, narrative_ready: true },
          row.organization_id,
        );
      }
    } catch (err) {
      failed++;
      logger.warn(
        { jobId: job.id, cacheKey: row.cache_key, err: (err as Error).message },
        'basis-explain: row failed, continuing',
      );
    }
    if ((narrated + failed + skippedNoProvider) % 10 === 0) {
      logger.info({ processed: narrated + failed + skippedNoProvider, total: pending.length }, 'basis-explain: progress');
    }
  }

  logger.info(
    { jobId: job.id, candidates: pending.length, narrated, skippedNoProvider, failed, durationMs: Date.now() - start },
    'basis-explain: done',
  );
}
