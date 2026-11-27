// createWsFrameGate (issue #177): the one per-message authorization helper
// every WebSocket hub uses.
import { describe, expect, it, vi } from 'vitest';
import { classifyYjsFrame, createWsFrameGate, wsFramePermissionId, YJS_FRAME_TYPES } from '../index.js';

const caller = { user_id: 'u-gilligan', org_id: 'org-minnow' };

const FRAMES = {
  subscribe: ['app.thing.read'],
  edit: ['app.thing.read', 'app.thing.update'],
  peek: ['shadow:app.thing.get'],
  leave: [],
} as const;

describe('createWsFrameGate', () => {
  it('lets a frame run when every enforced id is allowed', async () => {
    const gate = createWsFrameGate(FRAMES, async () => true);
    expect(await gate.check('edit', caller)).toBeNull();
  });

  it('refuses a frame naming the first id the caller lacks', async () => {
    const gate = createWsFrameGate(FRAMES, async (_c, id) => id !== 'app.thing.update');
    expect(await gate.check('subscribe', caller)).toBeNull();
    expect(await gate.check('edit', caller)).toEqual({
      code: 'PERMISSION_DENIED',
      frame_type: 'edit',
      permission_id: 'app.thing.update',
      message: 'Permission denied: app.thing.update',
    });
  });

  it('fails closed on a frame type the map does not declare', async () => {
    const probe = vi.fn(async () => true);
    const gate = createWsFrameGate(FRAMES, probe);
    expect((await gate.check('delete_everything', caller))?.code).toBe('UNKNOWN_FRAME');
    expect((await gate.check(undefined, caller))?.code).toBe('UNKNOWN_FRAME');
    // Object prototype keys are not frames.
    expect((await gate.check('constructor', caller))?.code).toBe('UNKNOWN_FRAME');
    expect(probe).not.toHaveBeenCalled();
  });

  it('runs an empty-list frame without asking the resolver', async () => {
    const probe = vi.fn(async () => false);
    const gate = createWsFrameGate(FRAMES, probe);
    expect(await gate.check('leave', caller)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('asks about a shadow id but never blocks on it, like shadowOnly()', async () => {
    const probe = vi.fn(async () => false);
    const warn = vi.fn();
    const gate = createWsFrameGate(FRAMES, probe);
    expect(await gate.check('peek', caller, { warn })).toBeNull();
    expect(probe).toHaveBeenCalledWith(caller, 'app.thing.get', { warn });
    expect(warn).toHaveBeenCalled();
  });

  it('treats a throwing probe as a deny', async () => {
    const gate = createWsFrameGate(FRAMES, async () => {
      throw new Error('api down');
    });
    expect((await gate.check('subscribe', caller))?.code).toBe('PERMISSION_DENIED');
  });

  it('reuses an allow for the TTL so a chatty frame does not hit the resolver per frame', async () => {
    let t = 0;
    const probe = vi.fn(async () => true);
    const gate = createWsFrameGate(FRAMES, probe, { allowTtlMs: 1000, now: () => t });
    await gate.check('subscribe', caller);
    await gate.check('subscribe', caller);
    expect(probe).toHaveBeenCalledTimes(1);
    t = 1001;
    await gate.check('subscribe', caller);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('never caches a deny: a grant takes effect on the next frame', async () => {
    let grant = false;
    const gate = createWsFrameGate(FRAMES, async () => grant);
    expect(await gate.check('subscribe', caller)).not.toBeNull();
    grant = true;
    expect(await gate.check('subscribe', caller)).toBeNull();
  });

  it('setCheckerForTests swaps the probe and drops cached allows', async () => {
    const gate = createWsFrameGate(FRAMES, async () => true);
    expect(await gate.check('subscribe', caller)).toBeNull();
    gate.setCheckerForTests(async () => false);
    expect(await gate.check('subscribe', caller)).not.toBeNull();
  });
});

describe('wsFramePermissionId', () => {
  it('strips the shadow prefix', () => {
    expect(wsFramePermissionId('shadow:a.b.c')).toBe('a.b.c');
    expect(wsFramePermissionId('a.b.c')).toBe('a.b.c');
  });
});

describe('classifyYjsFrame', () => {
  it('names the y-websocket frames a client sends', () => {
    expect(classifyYjsFrame(new Uint8Array([0, 0, 1, 0]))).toBe('sync_step1');
    expect(classifyYjsFrame(new Uint8Array([0, 1, 1, 0]))).toBe('sync_update');
    expect(classifyYjsFrame(new Uint8Array([0, 2, 1, 0]))).toBe('sync_update');
    expect(classifyYjsFrame(new Uint8Array([1, 3, 1, 2, 3]))).toBe('awareness');
  });

  it('gives anything else a name no map declares', () => {
    expect(classifyYjsFrame(new Uint8Array([2]))).toBe('yjs_2');
    expect(classifyYjsFrame(new Uint8Array([0, 9]))).toBe('yjs_sync_9');
    expect(classifyYjsFrame(new Uint8Array([]))).toBe('yjs_malformed');
    expect(YJS_FRAME_TYPES).not.toContain(classifyYjsFrame(new Uint8Array([2])));
  });
});
