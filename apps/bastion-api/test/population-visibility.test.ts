import { describe, expect, it, vi } from 'vitest';
import { nameVisibility, populationNames } from '../src/lib/population-visibility.js';
import type { Viewer } from '../src/services/types.js';

// #250 (residual of #227): repository names reach readers through summary.repos,
// population_checked and the explanation sentence, not only through cited refs. A counts-only
// reader gets counts only; a detail reader (an admin, or the control's owner) sees only the names
// of repositories in Bam projects they can open, whatever they own.

vi.mock('../src/env.js', () => ({ env: {} }));
vi.mock('../src/db/index.js', () => ({ db: {}, engineConnection: {}, engineReadConnection: {} }));
vi.mock('../src/lib/queue.js', () => ({ enqueueEvaluationRun: vi.fn() }));
vi.mock('@bigbluebam/storage', () => ({ withStorageTimeout: vi.fn() }));

const { present } = await import('../src/services/evidence.service.js');

const gilligan: Viewer = {
  id: 'u-gilligan',
  org_id: 'org-gilligan',
  role: 'member',
  is_superuser: false,
  auth_method: 'session',
  impersonator_id: null,
};

const HOWELL = 'howell/howell-ledger';
const RADIO = 'castaways/rescue-radio-firmware';

/** A change.merge_reviewed snapshot as migration 0279 writes it, over two repositories. */
const SNAPSHOT: Record<string, unknown> = {
  id: 'snap-1',
  control_id: 'ctl-change',
  probe_key: 'change.merge_reviewed',
  probe_version: 1,
  outcome: 'pass',
  population_checked: [HOWELL, RADIO],
  population_unlisted: [HOWELL],
  summary: {
    merges: 5,
    unreviewed_merges: 0,
    window_days: 30,
    cited_count: 0,
    repos: [
      { repo: HOWELL, enabled: true, subscribed_events: ['pull_request', 'pull_request_review'], reviews_subscribed: true },
      { repo: RADIO, enabled: true, subscribed_events: ['pull_request', 'pull_request_review'], reviews_subscribed: true },
    ],
  },
  cited_refs: [],
  overflow_count: 0,
};

// Howell Estate Finances is the private project; Gilligan is in the radio project only.
const PROJECTS = new Map([
  [HOWELL, ['p-howell-finances']],
  [RADIO, ['p-rescue-radio']],
]);
const canAccess = vi.fn(async (_u: string, type: string, id: string) => type === 'bam.project' && id === 'p-rescue-radio');

describe('evidence summary visibility (#250)', () => {
  it('a counts-only viewer (Mary Ann, viewer role) receives no repository name anywhere', () => {
    const out = present(SNAPSHOT, false);
    const body = JSON.stringify(out);
    expect(body).not.toContain('howell');
    expect(body).not.toContain('rescue-radio');
    expect(out.summary).toEqual({ merges: 5, unreviewed_merges: 0, window_days: 30, cited_count: 0 });
    expect(out.population_checked).toBeNull();
    expect(out.explanation).toContain('Checked 2 repositories.');
  });

  it('the control owner (Gilligan, not in Howell Estate Finances) never receives the Howell repo name', async () => {
    const visible = await nameVisibility(canAccess, gilligan, populationNames(SNAPSHOT), PROJECTS);
    const out = present(SNAPSHOT, true, visible);
    const body = JSON.stringify(out);
    expect(body).not.toContain(HOWELL);
    expect(out.population_checked).toEqual([RADIO]);
    expect(out.population_unlisted).toEqual([]);
    expect((out.summary as { repos: Array<{ repo: string }> }).repos.map((r) => r.repo)).toEqual([RADIO]);
    expect(out.population_hidden_count).toBe(1);
    expect(out.explanation).toContain(`Checked 2 repositories (${RADIO}, and 1 more you cannot see).`);
    // One can_access per distinct project, typed bam.project.
    expect(canAccess).toHaveBeenCalledWith('u-gilligan', 'bam.project', 'p-howell-finances');
  });

  it('a reader who can open both projects sees both names', async () => {
    const visible = await nameVisibility(async () => true, gilligan, populationNames(SNAPSHOT), PROJECTS);
    const out = present(SNAPSHOT, true, visible);
    expect(out.population_checked).toEqual([HOWELL, RADIO]);
    expect(out.population_hidden_count).toBe(0);
    expect(out.explanation).toContain(`(${HOWELL}, ${RADIO})`);
  });

  it('fails closed when can_access errors, and leaves names that are not connected repositories alone', async () => {
    const broken = vi.fn().mockRejectedValue(new Error('api down'));
    const visible = await nameVisibility(broken, gilligan, [HOWELL, 'typed/expected-repo', 'blip'], PROJECTS);
    expect(visible(HOWELL)).toBe(false);
    expect(visible('typed/expected-repo')).toBe(true);
    expect(visible('blip')).toBe(true);
  });
});
