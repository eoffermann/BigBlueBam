// Issue #177, table-driven over every app socket: each hub's real
// WS_FRAME_PERMISSIONS map, run through the real shared gate
// (createWsFrameGate from packages/permissions, built), refuses a frame whose
// REST twin's catalog id the caller lacks, passes the frames it holds, never
// blocks on a shadow: id (REST shadowOnly twins), and refuses undeclared frames.
// Requires `pnpm --filter @bigbluebam/permissions build` (CI builds every
// package before tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WS_FRAME_MAPS, parseFrameMap } from '../check-permission-catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createWsFrameGate } = await import(pathToFileURL(join(ROOT, 'packages/permissions/dist/index.js')).href);

const caller = { user_id: 'u-mary-ann', org_id: 'org-minnow' };

function hubMap(hub) {
  const parsed = parseFrameMap(readFileSync(join(ROOT, hub.map), 'utf8'), hub.exportName);
  assert.ok(parsed, `${hub.map}: map not found`);
  return Object.fromEntries(parsed);
}

// The frames each hub must actually block when the caller lacks the REST twin's
// grant. Pinned so a map entry cannot silently drift to [] or shadow:.
const ENFORCED = {
  'apps/bureau-api/src/routes/ws.routes.ts': ['knock', 'summon', 'set_door', 'lock_room', 'chat_send'],
  'apps/banter-api/src/ws/handler.ts': ['typing.start'],
  'apps/blip-api/src/routes/ws.routes.ts': ['subscribe'],
  'apps/blueprint-api/src/routes/ws.routes.ts': ['subscribe', 'cursor', 'selection'],
};

for (const hub of WS_FRAME_MAPS) {
  test(`${hub.handler}: a caller with no grants is refused exactly the enforced frames`, async () => {
    const frames = hubMap(hub);
    const gate = createWsFrameGate(frames, async () => false);
    const refused = [];
    for (const [frame, ids] of Object.entries(frames)) {
      const denial = await gate.check(frame, caller);
      const enforced = ids.filter((id) => !id.startsWith('shadow:'));
      if (enforced.length > 0) {
        assert.equal(denial?.code, 'PERMISSION_DENIED', `${frame} should be refused`);
        assert.equal(denial.permission_id, enforced[0]);
        refused.push(frame);
      } else {
        assert.equal(denial, null, `${frame} has no enforced id and must not be blocked`);
      }
    }
    for (const frame of ENFORCED[hub.handler] ?? []) {
      assert.ok(refused.includes(frame), `${frame} must be enforced on ${hub.handler}`);
    }
  });

  test(`${hub.handler}: a caller holding every grant passes every declared frame`, async () => {
    const frames = hubMap(hub);
    const gate = createWsFrameGate(frames, async () => true);
    for (const frame of Object.keys(frames)) {
      assert.equal(await gate.check(frame, caller), null, frame);
    }
  });

  test(`${hub.handler}: an undeclared frame type is refused`, async () => {
    const gate = createWsFrameGate(hubMap(hub), async () => true);
    assert.equal((await gate.check('drop_all_tables', caller))?.code, 'UNKNOWN_FRAME');
  });
}

test('only the missing grant is named: blueprint cursor needs diagram read', async () => {
  const hub = WS_FRAME_MAPS.find((h) => h.handler.includes('blueprint-api'));
  const gate = createWsFrameGate(hubMap(hub), async (_c, id) => id !== 'blueprint.diagram.read');
  const denial = await gate.check('cursor', caller);
  assert.equal(denial?.permission_id, 'blueprint.diagram.read');
});

test("banter typing.start is the REST message-post twin; typing.stop and leaving are never blocked", async () => {
  const hub = WS_FRAME_MAPS.find((h) => h.handler.includes('banter-api'));
  const gate = createWsFrameGate(hubMap(hub), async (_c, id) => id !== 'banter.channel_message.create');
  assert.equal((await gate.check('typing.start', caller))?.permission_id, 'banter.channel_message.create');
  assert.equal(await gate.check('typing.stop', caller), null);
  assert.equal(await gate.check('unsubscribe', caller), null);
  assert.equal(await gate.check('subscribe', caller), null);
});
