import { describe, it, expect, vi } from 'vitest';
import * as shared from '@bigbluebam/shared';

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    LOG_LEVEL: 'silent',
  },
}));
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));

import { LAUNCHPAD_APP_IDS, LAUNCHPAD_CATALOG } from '../src/routes/system-settings.routes.js';

/**
 * Issue #144: the api and the MCP tools share ONE Launchpad app-id list from
 * @bigbluebam/shared. The api re-exports it (the docs/nginx scripts still parse
 * LAUNCHPAD_CATALOG from system-settings.routes.ts), so the catalog rows must
 * cover exactly those ids in the same order.
 */
describe('Launchpad app ids (issue #144)', () => {
  it('the api re-exports the shared const itself, not a copy', () => {
    expect(LAUNCHPAD_APP_IDS).toBe(shared.LAUNCHPAD_APP_IDS);
  });

  it('LAUNCHPAD_CATALOG lists exactly the shared ids, in order', () => {
    expect(LAUNCHPAD_CATALOG.map((e) => e.id)).toEqual([...shared.LAUNCHPAD_APP_IDS]);
  });
});
