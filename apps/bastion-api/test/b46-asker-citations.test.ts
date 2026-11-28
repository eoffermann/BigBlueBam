import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readersMay } from '../src/lib/asker.js';
import { nameVisibility } from '../src/lib/population-visibility.js';
import { citationVisible, visibleRefs } from '../src/services/decisions.service.js';
import type { Viewer } from '../src/services/types.js';

// #414: the evidence, fix-draft and exception reads cite source records (PRs, API keys, people).
// An agent reading for a person passes asker_user_id; every cited record then has to pass
// can_access for the caller AND the asker, as the manual-evidence reads already narrow (#217).
// Before the fix the asker was ignored: an admin key relayed records the asker could not open.

const skipper: Viewer = { id: 'u-skipper', org_id: 'org-1', role: 'owner', is_superuser: false, auth_method: 'api_key', impersonator_id: null };
const forGilligan: Viewer = { ...skipper, asker_id: 'u-gilligan' };

/** Skipper sees everything; Gilligan never sees the Howells' PR, their key or their project. */
const canAccess = vi.fn(async (user: string, _type: string, id: string) => user === 'u-skipper' || !id.startsWith('howell'));

describe('readersMay: the one visibility decision for a cited record (#414)', () => {
  it('without an asker it is the caller alone; with one, both must pass', async () => {
    expect(await readersMay(canAccess, skipper, 'bam.github_pr_event', 'howell-pr')).toBe(true);
    expect(await readersMay(canAccess, forGilligan, 'bam.github_pr_event', 'howell-pr')).toBe(false);
    expect(await readersMay(canAccess, forGilligan, 'bam.github_pr_event', 'radio-pr')).toBe(true);
  });

  it('never widens: a record the caller cannot see stays hidden whatever the asker may see', async () => {
    const onlyAsker = vi.fn(async (user: string) => user === 'u-gilligan');
    expect(await readersMay(onlyAsker, forGilligan, 'bam.api_key', 'k1')).toBe(false);
  });

  it('fails closed when the asker check errors', async () => {
    const flaky = vi.fn(async (user: string) => {
      if (user === 'u-gilligan') throw new Error('api down');
      return true;
    });
    expect(await readersMay(flaky, forGilligan, 'bam.user', 'u1')).toBe(false);
  });
});

describe('citations and population names narrow for the asker (#414)', () => {
  const refs = [
    { entity_type: 'github_pr_event', entity_id: 'radio-pr' },
    { entity_type: 'github_pr_event', entity_id: 'howell-pr' },
    { entity_type: 'api_key', entity_id: 'howell-key' },
  ];

  it('citationVisible and visibleRefs drop what the asker cannot open', async () => {
    expect(await citationVisible(canAccess, forGilligan, refs[1]!)).toBe(false);
    expect((await visibleRefs(canAccess, skipper, refs)).map((r) => r.entity_id)).toEqual(['radio-pr', 'howell-pr', 'howell-key']);
    expect((await visibleRefs(canAccess, forGilligan, refs)).map((r) => r.entity_id)).toEqual(['radio-pr']);
  });

  it('repository names pass for the asker too', async () => {
    const projects = new Map([
      ['gilligan-travel/rescue-radio-firmware', ['radio-project']],
      ['gilligan-travel/howell-estate', ['howell-project']],
    ]);
    const names = ['gilligan-travel/rescue-radio-firmware', 'gilligan-travel/howell-estate'];
    const asCaller = await nameVisibility(canAccess, skipper, names, projects);
    const asAsker = await nameVisibility(canAccess, forGilligan, names, projects);
    expect(names.filter(asCaller)).toEqual(names);
    expect(names.filter(asAsker)).toEqual(['gilligan-travel/rescue-radio-firmware']);
  });
});

describe('the citation-bearing routes check and honor asker_user_id (#414)', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../src/routes', f), 'utf8');
  const ROUTES: Array<[string, string, string]> = [
    ['evidence.routes.ts', '/controls/:id/evidence', 'bastion.evidence.read'],
    ['evidence.routes.ts', '/evidence/:id', 'bastion.evidence.read'],
    ['decisions.routes.ts', '/fix-drafts', 'bastion.fix.read'],
    ['decisions.routes.ts', '/fix-drafts/:id', 'bastion.fix.read'],
    ['decisions.routes.ts', '/exceptions', 'bastion.exception.read'],
    ['decisions.routes.ts', '/exceptions/:id', 'bastion.exception.read'],
  ];

  /** The route declaration through the end of its handler (up to the next route). */
  function route(src: string, path: string): string {
    const at = src.indexOf(`fastify.get('${path}', {`);
    expect(at, path).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('\n  fastify.', at + 1);
    return src.slice(at, next < 0 ? src.length : next);
  }

  it.each(ROUTES)('%s GET %s runs requireAskerCan and reads with askingViewerOf', (file, path, perm) => {
    const body = route(read(file), path);
    expect(body).toMatch(new RegExp(`asker\\('${perm.replace(/\./g, '\\.')}'\\)`));
    expect(body).toMatch(/askingViewerOf\(request\)/);
    expect(body).not.toMatch(/\bviewerOf\(request\)/);
  });

  it('list routes strip asker_user_id from the strict query only where it is honored', () => {
    const src = read('decisions.routes.ts');
    for (const path of ['/fix-drafts', '/exceptions']) expect(route(src, path)).toMatch(/query\(request, true\)/);
    for (const path of ['/gaps', '/drift']) expect(route(src, path)).toMatch(/query\(request\)\)/);
  });
});
