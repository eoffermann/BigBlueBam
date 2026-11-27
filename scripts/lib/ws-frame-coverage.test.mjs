// Issue #177: the permission-catalog check's WebSocket section now covers every
// app socket, not only Bureau's (#166). These tests pin that it passes on the
// real tree and fails on each way a hub can drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WS_FRAME_MAPS,
  WS_PUSH_ONLY,
  jsonFrameTypes,
  parseFrameMap,
  wsFrameCoverageProblems,
} from '../check-permission-catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Sockets deliberately outside the catalog check, with the reason.
const EXEMPT_SOCKETS = new Map([
  // Callers are helpdesk portal customers, which the Bam permission catalog does not cover;
  // ticket ownership is the gate on every frame.
  [`apps${sep}helpdesk-api${sep}src${sep}ws${sep}handler.ts`, 'portal customers, not catalog subjects'],
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield full;
  }
}

test('every app socket is mapped, push-only, or explicitly exempt', () => {
  const covered = new Set([
    ...WS_FRAME_MAPS.map((h) => h.handler.split('/').join(sep)),
    ...WS_PUSH_ONLY.map((f) => f.split('/').join(sep)),
  ]);
  const missing = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    if (!/^api$|-api$/.test(app)) continue;
    let src;
    try {
      src = join(ROOT, 'apps', app, 'src');
      statSync(src);
    } catch {
      continue;
    }
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      if (!/websocket:\s*true/.test(text)) continue;
      const rel = relative(ROOT, file);
      if (!covered.has(rel) && !EXEMPT_SOCKETS.has(rel)) missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], `Give these sockets a WS_FRAME_PERMISSIONS map (issue #177):\n${missing.join('\n')}`);
});

test('the real tree has no WebSocket frame coverage problems', () => {
  const { problems, frames } = wsFrameCoverageProblems(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(frames > 40, `expected every hub's frames to be counted, got ${frames}`);
});

test('the map parser reads quoted keys, shadow ids and as-const maps', () => {
  const map = parseFrameMap(
    "export const WS_FRAME_PERMISSIONS = {\n  subscribe: [],\n  'typing.start': ['banter.x.create'],\n  peek: ['shadow:a.b.get'],\n} as const satisfies Record<string, readonly string[]>;\n",
    'WS_FRAME_PERMISSIONS',
  );
  assert.deepEqual([...map.entries()], [
    ['subscribe', []],
    ['typing.start', ['banter.x.create']],
    ['peek', ['shadow:a.b.get']],
  ]);
});

test('JSON frame types are found from switch cases, equality checks and zod literals', () => {
  const found = jsonFrameTypes(
    "switch (msg.type) { case 'join': break; case 'typing.stop': break; }\nif (msg.type === 'ping') {}\nconst s = z.object({ type: z.literal('subscribe') });",
  );
  assert.deepEqual([...found].sort(), ['join', 'ping', 'subscribe', 'typing.stop']);
});

// A miniature repo: one JSON hub, one Yjs hub, one push-only socket.
function fixture({ handler, map, yjsHandler, yjsMap, push }) {
  const root = mkdtempSync(join(tmpdir(), 'ws-frames-'));
  const put = (p, text) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  put('docs/permissions-action-manifest.json', JSON.stringify({ permissions: [{ id: 'app.thing.read' }, { id: 'app.thing.update' }] }));
  put('h.ts', handler);
  put('m.ts', map);
  put('y.ts', yjsHandler);
  put('ym.ts', yjsMap);
  put('p.ts', push);
  const hubs = [
    { handler: 'h.ts', map: 'm.ts', exportName: 'WS_FRAME_PERMISSIONS', gateCall: 'gate.check(' },
    { handler: 'y.ts', map: 'ym.ts', exportName: 'WS_FRAME_PERMISSIONS', gateCall: 'gate.check(', frames: 'yjs' },
  ];
  return wsFrameCoverageProblems(root, null, hubs, ['p.ts']).problems;
}

const GOOD = {
  handler: "await gate.check(msg.type);\nswitch (msg.type) { case 'subscribe': break; case 'edit': break; }",
  map: "export const WS_FRAME_PERMISSIONS = {\n  subscribe: ['shadow:app.thing.read'],\n  edit: ['app.thing.update'],\n};\n",
  yjsHandler: 'await gate.check(classifyYjsFrame(data));',
  yjsMap:
    "export const WS_FRAME_PERMISSIONS = {\n  sync_step1: ['app.thing.read'],\n  sync_update: ['app.thing.update'],\n  awareness: [],\n};\n",
  push: "subscriber.on('message', () => {});",
};

test('a consistent fixture passes', () => {
  assert.deepEqual(fixture(GOOD), []);
});

test('a frame the handler accepts but the map does not name fails', () => {
  const problems = fixture({ ...GOOD, handler: `${GOOD.handler}\nswitch (x) { case 'delete_all': break; }` });
  assert.ok(problems.some((p) => p.includes("frame 'delete_all' has no entry")), problems.join('\n'));
});

test('an id outside the catalog fails, shadow prefix or not', () => {
  const problems = fixture({ ...GOOD, map: GOOD.map.replace("'app.thing.update'", "'shadow:app.nope.update'") });
  assert.ok(problems.some((p) => p.includes("'app.nope.update', which is not in the catalog")), problems.join('\n'));
});

test('a handler that stops calling the gate fails', () => {
  const problems = fixture({ ...GOOD, handler: GOOD.handler.replace('await gate.check(msg.type);', '') });
  assert.ok(problems.some((p) => p.includes('no longer calls gate.check(')), problems.join('\n'));
});

test('a Yjs hub missing a frame type, or no longer classifying frames, fails', () => {
  const a = fixture({ ...GOOD, yjsMap: GOOD.yjsMap.replace("  awareness: [],\n", '') });
  assert.ok(a.some((p) => p.includes("frame 'awareness' has no entry")), a.join('\n'));
  const b = fixture({ ...GOOD, yjsHandler: 'await gate.check(data[0]);' });
  assert.ok(b.some((p) => p.includes('classifyYjsFrame')), b.join('\n'));
});

test('a push-only socket that starts reading client frames fails', () => {
  const problems = fixture({ ...GOOD, push: `${GOOD.push}\nsocket.on('message', () => {});` });
  assert.ok(problems.some((p) => p.includes('now reads client frames')), problems.join('\n'));
});
