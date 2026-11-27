import { describe, it, expect, vi, afterEach } from 'vitest';

// updateNode pushes a bam.task node's label into the referenced Bam task. The
// api only applies the sync inside the org named in the payload (a node's
// ref_entity_id can name any org's task), so the payload must carry the
// diagram's org or every sync is refused.

const DIAGRAM_ORG = '33333333-3333-4333-8333-333333333333';

vi.mock('../src/env.js', () => ({
  env: { INTERNAL_SERVICE_SECRET: 'x'.repeat(32), BBB_API_INTERNAL_URL: 'http://api:4000' },
}));
vi.mock('../src/db/index.js', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [
            { id: 'n1', diagram_id: 'd1', ref_entity_type: 'bam.task', ref_entity_id: '44444444-4444-4444-8444-444444444444' },
          ],
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ org_id: DIAGRAM_ORG }] }) }) }),
  },
}));

import { updateNode } from '../src/services/node.service.js';

describe('updateNode -> Bam task sync', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the diagram's org with the task id", async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await updateNode('d1', 'n1', { label: 'Renamed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api:4000/internal/sync-from-blueprint');
    expect(JSON.parse(String(init.body))).toMatchObject({
      task_id: '44444444-4444-4444-8444-444444444444',
      org_id: DIAGRAM_ORG,
      title: 'Renamed',
    });
  });
});
