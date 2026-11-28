// Which population member names a reader may see (#250, residual of #227).
//
// The change.* probes list repositories by name: population_checked, population_unlisted and
// summary.repos[].repo are "<owner>/<name>" of github_integrations rows, each attached to a Bam
// project. A repository name is visible to a reader only when the reader can see a Bam project it
// is connected to: can_access(reader, 'bam.project', project_id), the same rule the api's
// preflightGithubPrEvent applies to the PRs themselves. Owning the control does not widen this.
//
// A name that is not a connected repository in this organization (a name someone typed into the
// control's expected list, an app name for the logging probes) is not tied to any project, so it
// is shown to detail viewers as before. A failing can_access fails closed.

import type { Viewer } from '../services/types.js';
import { readersMay } from './asker.js';
import type { Tx } from '../engine/context.js';

export type CanAccessFn = (askerUserId: string, entityType: string, entityId: string) => Promise<boolean>;

/** A verdict per name: may this reader see it. */
export type NameVisible = (name: string) => boolean;

/** Lower-cased "<owner>/<name>" -> the Bam projects the repository is connected to in this org. */
export async function repositoryProjects(tx: Tx, orgId: string, names: string[]): Promise<Map<string, string[]>> {
  const wanted = [...new Set(names.filter((n) => typeof n === 'string' && n.length > 0).map((n) => n.toLowerCase()))];
  const out = new Map<string, string[]>();
  if (wanted.length === 0) return out;
  const rows = await tx`
    SELECT DISTINCT lower(gi.repo_owner || '/' || gi.repo_name) AS repo, gi.project_id::text AS project_id
      FROM github_integrations gi
      JOIN projects p ON p.id = gi.project_id
     WHERE p.org_id = ${orgId}
       AND lower(gi.repo_owner || '/' || gi.repo_name) = ANY (${wanted})`;
  for (const r of rows) {
    const repo = String(r.repo);
    out.set(repo, [...(out.get(repo) ?? []), String(r.project_id)]);
  }
  return out;
}

/**
 * The visibility verdict for every name, given which projects each repository is connected to.
 * Asks can_access once per distinct project. Pure apart from canAccess, for tests.
 */
export async function nameVisibility(
  canAccess: CanAccessFn,
  viewer: Viewer,
  names: string[],
  projectsOf: Map<string, string[]>,
): Promise<NameVisible> {
  const projectVerdict = new Map<string, boolean>();
  const hidden = new Set<string>();
  for (const name of new Set(names.map((n) => String(n).toLowerCase()))) {
    const projects = projectsOf.get(name);
    if (!projects || projects.length === 0) continue; // not a connected repository: not project data
    let visible = false;
    for (const pid of projects) {
      let ok = projectVerdict.get(pid);
      if (ok === undefined) {
        // The viewer and, reading for a person, the asker too (#414).
        ok = await readersMay(canAccess, viewer, 'bam.project', pid);
        projectVerdict.set(pid, ok);
      }
      if (ok) {
        visible = true;
        break;
      }
    }
    if (!visible) hidden.add(name);
  }
  return (name: string) => !hidden.has(String(name).toLowerCase());
}

/** repositoryProjects + nameVisibility in one call. */
export async function populationVisibility(tx: Tx, canAccess: CanAccessFn, viewer: Viewer, names: string[]): Promise<NameVisible> {
  return nameVisibility(canAccess, viewer, names, await repositoryProjects(tx, viewer.org_id, names));
}

/** Every population member name a snapshot row carries (checked, unlisted, summary.repos). */
export function populationNames(row: { population_checked?: unknown; population_unlisted?: unknown; summary?: unknown }): string[] {
  const names: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') names.push(v);
  };
  if (Array.isArray(row.population_checked)) row.population_checked.forEach(push);
  if (Array.isArray(row.population_unlisted)) row.population_unlisted.forEach(push);
  const repos = (row.summary as Record<string, unknown> | null | undefined)?.repos;
  if (Array.isArray(repos)) for (const r of repos) push((r as Record<string, unknown> | null)?.repo);
  return names;
}
