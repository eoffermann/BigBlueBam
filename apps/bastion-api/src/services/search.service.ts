// GET /search (spec 5.1 row 95, 8.5): controls and linked policies for the platform's
// search_everything fan-out. Matching and scoring are pure (scoreMatch) so they are unit-tested
// without a database; the control read is one org-scoped query and the policy read reuses
// listPolicies, so a policy's title is exactly what the Policies page shows this viewer.

import type { BastionSearchHit, BastionSearchQuery } from '@bigbluebam/shared';
import { orgTx } from '../engine/context.js';
import { tsQueryTerms } from '../library/questionnaire-draft.js';
import { listPolicies, type PolicyDeps } from './policies.service.js';
import type { Viewer } from './types.js';

/** Candidate controls read before scoring; the route caps the answer at `limit` (at most 50). */
const CONTROL_CANDIDATES = 200;

export const SEARCH_URLS = {
  control: (id: string) => `/bastion/controls/${id}`,
  // The Policies page lists every policy; there is no per-policy page.
  policy: () => '/bastion/policies',
} as const;

/** Lower-case words of at least two characters, letters and digits only. */
export function queryWords(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2),
    ),
  ];
}

/**
 * 0..1: how well a title (and optional summary) matches the query. The whole phrase in the title
 * scores highest; otherwise the share of query words found, title words weighted above summary
 * words. 0 means no match (the hit is dropped).
 */
export function scoreMatch(q: string, title: string, summary = ''): number {
  const words = queryWords(q);
  if (words.length === 0) return 0;
  const t = title.toLowerCase();
  const s = summary.toLowerCase();
  const phrase = q.trim().toLowerCase();
  if (phrase.length >= 2 && t.includes(phrase)) return t === phrase ? 1 : 0.95;
  const inTitle = words.filter((w) => t.includes(w)).length / words.length;
  const inSummary = words.filter((w) => !t.includes(w) && s.includes(w)).length / words.length;
  const score = 0.8 * inTitle + 0.4 * inSummary;
  return Math.min(0.9, Number(score.toFixed(4)));
}

function snippet(text: string, max = 240): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchBastion(
  d: PolicyDeps,
  viewer: Viewer,
  query: BastionSearchQuery,
  opts: { includePolicies: boolean },
): Promise<{ data: BastionSearchHit[] }> {
  const terms = tsQueryTerms(query.q);
  const pattern = likePattern(query.q);
  const controls = await orgTx(d.engine.sql, viewer.org_id, async (tx) =>
    await tx.unsafe(
      `SELECT c.id, c.title, coalesce(c.plain_summary, '') AS summary
         FROM bastion_controls c
        WHERE c.organization_id = $1 AND c.lifecycle = 'active'
          AND (c.title ILIKE $2 OR c.plain_summary ILIKE $2 OR c.control_key ILIKE $2
               ${terms ? `OR c.tsv @@ to_tsquery('english', $4)` : ''})
        ORDER BY c.title LIMIT $3`,
      terms ? [viewer.org_id, pattern, CONTROL_CANDIDATES, terms] : [viewer.org_id, pattern, CONTROL_CANDIDATES],
    ),
  );

  const hits: BastionSearchHit[] = [];
  for (const c of controls as unknown as Array<{ id: string; title: string; summary: string }>) {
    // A full-text hit on a stemmed word may not appear verbatim; keep it with a floor score.
    const score = scoreMatch(query.q, String(c.title), String(c.summary)) || 0.3;
    hits.push({
      entity_type: 'bastion.control',
      id: String(c.id),
      title: String(c.title),
      snippet: snippet(String(c.summary)),
      score,
      url: SEARCH_URLS.control(String(c.id)),
    });
  }

  if (opts.includePolicies) {
    const { data: policies } = await listPolicies(d, viewer, { status: 'active' });
    for (const p of policies) {
      const title = String(p.title);
      const score = scoreMatch(query.q, title);
      if (score === 0) continue;
      hits.push({
        entity_type: 'bastion.policy',
        id: String(p.id),
        title,
        snippet: snippet(String(p.attestation_label ?? 'Policy linked from Beacon')),
        score,
        url: SEARCH_URLS.policy(),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { data: hits.slice(0, query.limit) };
}
