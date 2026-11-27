import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #274 (and #217): asker_user_id narrows, never widens. Every questionnaire and answer-library
// read that carries customer data, and the one-off draft, must run requireAskerCan (403
// ASKER_FORBIDDEN when the asker may not see it), and a route that does not honor the asker must
// not quietly drop it from the query (its strict schema then refuses it with 400).

const SRC = readFileSync(join(__dirname, '../src/routes/questionnaires.routes.ts'), 'utf8');

/** Each route declaration: method, path, preHandler text and the handler body up to the next route. */
function routes() {
  const re = /fastify\.(get|post|patch|put|delete)\(\s*'([^']+)',\s*\{\s*preHandler:\s*\[([^\]]*)\]/g;
  const found = [...SRC.matchAll(re)].map((m) => ({ key: `${m[1]!.toUpperCase()} ${m[2]}`, pre: m[3]!, at: m.index! }));
  return found.map((r, i) => ({ ...r, body: SRC.slice(r.at, found[i + 1]?.at ?? SRC.length) }));
}

const MUST_HONOR = ['GET /questionnaires', 'GET /questionnaires/:id', 'GET /questionnaires/:id/items', 'POST /answers/draft', 'GET /answer-library'];

describe('asker_user_id on the questionnaire routes (#274)', () => {
  it('every customer-data read and the one-off draft check the asker', () => {
    const all = routes();
    for (const key of MUST_HONOR) {
      const r = all.find((x) => x.key === key);
      expect(r, key).toBeDefined();
      expect(r!.pre, key).toMatch(/fastify\.requireAskerCan\('bastion\.(questionnaire|answer_library)\.(read|write)'\)/);
    }
  });

  it('only routes that check the asker take it out of the query; the others leave it for the strict schema to refuse', () => {
    for (const r of routes()) {
      const honors = r.pre.includes('requireAskerCan');
      if (r.body.includes('query(request, true)')) expect(honors, `${r.key} strips asker_user_id without checking it`).toBe(true);
      if (!honors) expect(r.body, r.key).not.toMatch(/askerOf\(request\)/);
    }
    // No helper may drop asker_user_id unconditionally again.
    expect(SRC).not.toMatch(/k !== 'asker_user_id' &&/);
  });

  it('the draft passes the asker to the service so citations are checked for both', () => {
    const draft = routes().find((r) => r.key === 'POST /answers/draft')!;
    expect(draft.body).toMatch(/draftOneAnswer\(.*askerOf\(request\)\)\)/);
  });
});
