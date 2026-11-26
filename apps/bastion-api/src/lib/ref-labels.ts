// Plain names for the platform rows a probe cites (spec 6.2: named chips, never raw ids), for
// viewers who may see evidence detail. Probes store ids only (cited_refs); names are read at
// display time, org-scoped, and every name that came from outside (a PR title, a key label, a
// person's display name) passes the injection pre-scan first: a suspect name is replaced by a
// neutral description, never quoted.

import type { Tx } from '../engine/context.js';
import { scanLabel } from './injection-prescan.js';

export interface CitedRef {
  entity_type: string;
  entity_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABELS = 50;

function safe(label: string, fallback: string): string {
  const flat = label.replace(/\s+/g, ' ').trim().slice(0, 160);
  return flat && !scanLabel(flat).suspected ? flat : fallback;
}

/** `${entity_type}:${entity_id}` -> a plain name. Unknown types and missing rows get none. */
export async function labelRefs(tx: Tx, orgId: string, refs: CitedRef[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (type: string) => [...new Set(refs.filter((r) => r.entity_type === type && UUID_RE.test(r.entity_id)).map((r) => r.entity_id))].slice(0, MAX_LABELS);
  const keys = ids('api_key');
  if (keys.length > 0) {
    for (const k of await tx`SELECT id, name FROM api_keys WHERE org_id = ${orgId} AND id = ANY(${keys}::uuid[])`) {
      out.set(`api_key:${k.id as string}`, `API key "${safe(String(k.name ?? ''), 'unnamed')}"`);
    }
  }
  const users = ids('user');
  if (users.length > 0) {
    for (const u of await tx`SELECT u.id, u.display_name FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
                             WHERE u.id = ANY(${users}::uuid[])`) {
      out.set(`user:${u.id as string}`, safe(String(u.display_name ?? ''), 'a person'));
    }
  }
  const prs = ids('github_pr_event');
  if (prs.length > 0) {
    for (const p of await tx`SELECT id, pr_number, pr_title, repo_name FROM github_pr_events WHERE org_id = ${orgId} AND id = ANY(${prs}::uuid[])`) {
      const title = safe(String(p.pr_title ?? ''), 'title hidden: it looked like instructions');
      out.set(`github_pr_event:${p.id as string}`, `PR #${Number(p.pr_number)} in ${safe(String(p.repo_name ?? ''), 'a repository')}: ${title}`);
    }
  }
  return out;
}

/** The labels for one row's refs, in the row's order (refs without a name are skipped). */
export function labelsFor(refs: CitedRef[], names: Map<string, string>): string[] {
  return refs.map((r) => names.get(`${r.entity_type}:${r.entity_id}`)).filter((x): x is string => !!x);
}
