// Issue #166: the Bureau WebSocket hub gates every frame type with the same
// bureau.* catalog ids as the REST routes, so a viewer or guest denied
// POST /v1/summon (etc.) by migration 0268 is denied the same action over the
// socket, and an operator revoking a grant takes effect on both surfaces.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/env.js', () => ({
  env: { BBB_PERMISSIONS_ENFORCE: 'on', BBB_API_INTERNAL_URL: 'http://api:4000', INTERNAL_SERVICE_SECRET: 'x'.repeat(32) },
}));

import {
  WS_FRAME_PERMISSIONS,
  deniedPermissionForFrame,
  setWsPermissionCheckForTests,
} from '../src/lib/ws-permissions.js';

const REPO = resolve(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');

type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

/** Built-in defaults as production seeds them: 0268 plus 0271 (bureau.chat.write). */
function granted(role: Role, id: string): boolean {
  const sql = read('infra/postgres/migrations/0268_blueprint_bureau_builtin_group_defaults.sql');
  const listAfter = (marker: string) => {
    const at = sql.indexOf(marker);
    const open = sql.indexOf('(', sql.indexOf(' IN', at));
    return new Set([...sql.slice(open, sql.indexOf(')', open)).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!));
  };
  const manifest = JSON.parse(read('docs/permissions-action-manifest.json')) as {
    permissions: Array<{ id: string; is_read: boolean }>;
  };
  const row = manifest.permissions.find((p) => p.id === id);
  if (!row) return false;
  if (id === 'bureau.chat.write') {
    const m0271 = read('infra/postgres/migrations/0271_bureau_chat_write_builtin_group_defaults.sql');
    return role !== 'guest' && m0271.includes(`WHEN '${role}' THEN true`);
  }
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'member') return !listAfter("WHEN 'member'").has(id);
  if (role === 'viewer') return row.is_read || listAfter('OR p.id IN').has(id);
  return false;
}

let currentRole: Role = 'member';
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  setWsPermissionCheckForTests(async (_caller, id) => {
    calls.push(id);
    return granted(currentRole, id);
  });
});

const caller = { user_id: 'u1', org_id: 'o1' };

describe('Bureau WebSocket frame permission map (#166)', () => {
  it('maps every frame the hub handles, and nothing it does not', () => {
    const handler = read('apps/bureau-api/src/routes/ws.routes.ts');
    const cases = [...handler.matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1]!).sort();
    expect(Object.keys(WS_FRAME_PERMISSIONS).sort()).toEqual(cases);
    expect(handler).toContain('deniedPermissionForFrame(');
  });

  it('uses only catalogued bureau.* ids', () => {
    const manifest = JSON.parse(read('docs/permissions-action-manifest.json')) as { permissions: Array<{ id: string }> };
    const ids = new Set(manifest.permissions.map((p) => p.id));
    for (const [frame, required] of Object.entries(WS_FRAME_PERMISSIONS)) {
      for (const id of required) expect(ids.has(id), `${frame} -> ${id}`).toBe(true);
    }
  });

  it('gates the frames named in the issue with their REST twins', () => {
    expect(WS_FRAME_PERMISSIONS.knock).toEqual(['bureau.knock.create']);
    expect(WS_FRAME_PERMISSIONS.knock_respond).toEqual(['bureau.knock.respond']);
    expect(WS_FRAME_PERMISSIONS.summon).toEqual(['bureau.summon.create']);
    expect(WS_FRAME_PERMISSIONS.set_door).toEqual(['bureau.room.write']);
    expect(WS_FRAME_PERMISSIONS.lock_room).toEqual(['bureau.room.write']);
    expect(WS_FRAME_PERMISSIONS.set_status).toEqual(['bureau.status.update']);
    expect(WS_FRAME_PERMISSIONS.chat_join).toEqual(['bureau.chat.read']);
    expect(WS_FRAME_PERMISSIONS.chat_send).toEqual(['bureau.chat.write']);
    expect(WS_FRAME_PERMISSIONS.subscribe_floor).toContain('bureau.presence.read');
    expect(WS_FRAME_PERMISSIONS.enter_room).toContain('bureau.presence.read');
  });
});

describe('deniedPermissionForFrame under the built-in defaults', () => {
  it('denies a viewer the actions 0268 withholds (the attack in the issue)', async () => {
    currentRole = 'viewer';
    for (const frame of ['summon', 'knock', 'knock_respond', 'set_door', 'lock_room', 'summon_grant_access', 'bring_start']) {
      expect(await deniedPermissionForFrame(frame, caller), frame).not.toBeNull();
    }
    for (const frame of ['subscribe_floor', 'enter_room', 'set_status', 'chat_join', 'chat_send', 'ring_respond', 'heartbeat']) {
      expect(await deniedPermissionForFrame(frame, caller), frame).toBeNull();
    }
  });

  it('denies a guest every gated frame, including presence streaming and chat', async () => {
    currentRole = 'guest';
    for (const [frame, required] of Object.entries(WS_FRAME_PERMISSIONS)) {
      const denied = await deniedPermissionForFrame(frame, caller);
      expect(denied, frame).toBe(required.length > 0 ? required[0] : null);
    }
  });

  it('lets a member through every frame', async () => {
    currentRole = 'member';
    for (const frame of Object.keys(WS_FRAME_PERMISSIONS)) {
      expect(await deniedPermissionForFrame(frame, caller), frame).toBeNull();
    }
  });

  it('never blocks leaving, and leaves unknown types to the hub default branch', async () => {
    currentRole = 'guest';
    for (const frame of ['leave_room', 'chat_leave', 'bring_cancel', 'bring_leave', 'heartbeat', 'not_a_frame']) {
      expect(await deniedPermissionForFrame(frame, caller), frame).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('reflects an operator revoking a grant', async () => {
    setWsPermissionCheckForTests(async (_c, id) => id !== 'bureau.summon.create');
    expect(await deniedPermissionForFrame('summon', caller)).toBe('bureau.summon.create');
  });
});
