# Beacon T4 Co-editing: Design Decisions

Implementation notes for adding T4 real-time CRDT co-editing to Beacon article
bodies (branch `feat/beacon-coediting`).

## Editor choice: CodeMirror 6 + y-codemirror.next (NOT Tiptap like Brief)

Brief's T4 stack is Tiptap/ProseMirror over a Yjs `XmlFragment` (rich text).
Beacon is different: articles are stored as **markdown** (`beacon_entries.body_markdown`)
and Beacon is a knowledge base where exact markdown fidelity matters (fenced code
blocks, tables, indentation). Reusing Brief's Tiptap editor would force a
markdown -> HTML -> markdown round-trip (via turndown) on every existing article,
which is **lossy** and would silently rewrite existing content.

Decision: use **CodeMirror 6 + `y-codemirror.next`** for the Beacon body editor.
- Content stays plain markdown end to end (no HTML round-trip, no corruption of
  existing articles).
- `y-codemirror.next` is the maintained Yjs binding for CodeMirror 6: real
  collaborative cursors + selection + remote-cursor awareness out of the box.
- Smaller dependency footprint than the full Tiptap suite.
- The Yjs **server** is editor-agnostic (it syncs binary `Y.Doc` updates + relays
  awareness), so Brief's server pattern ports directly; only the persisted doc
  field and the materialization differ.

Trade-off accepted: Beacon and Brief now use different editors. They have
genuinely different content models (markdown source vs rich doc), so this is the
right specialization, not gratuitous divergence. Reversible (feature branch, not
deployed).

## Contract between server and client (must match)

- Yjs document = one `Y.Doc` per beacon entry; the body lives in
  `ydoc.getText('body')` (a `Y.Text` of the markdown source).
- Room / doc id = the beacon entry UUID.
- Transport = `y-websocket` protocol (y-protocols sync + awareness), WS path
  `/beacon/ws` (the provider appends `/<beaconId>`), proxied to beacon-api `/ws`.
- Persistence (server): new `beacon_entries.yjs_state bytea` +
  `yjs_last_saved_at`. On debounced save, materialize
  `body_markdown = ydoc.getText('body').toString()`. On first load of an entry
  with no `yjs_state`, **seed** the `Y.Text` from the existing `body_markdown`
  so existing articles open intact.
- Awareness local state: `{ user: { name, color, userId } }`.

## Coexistence with the existing REST flow + 409 stale-write guard

- Title / summary / tags / visibility / publish still go through the existing
  REST PUT `/beacons/:id` (unchanged), including the `expected_updated_at` 409
  guard for those fields.
- The **body** is owned by Yjs once co-editing is active: the server debounce
  materializes `body_markdown`, so the REST body field is a mirror. On an
  explicit Save/Publish the editor sends `getBody()` — the LIVE Yjs text read
  straight from the doc (not stale React state), so the snapshot matches the
  shared document and an early/unsynced save can't clobber it (when the live doc
  is still empty it falls back to the last-persisted `body_markdown`).
- Publish (`body_html` render) continues to derive from the materialized
  `body_markdown`.

## Implementation outcome + two bugs found during verification

Server (beacon-api): migration `0203_beacon_yjs_state.sql` (yjs_state bytea +
yjs_last_saved_at), `services/yjs-persistence.service.ts`, `ws/handler.ts`,
`ws/auth.ts`, server.ts registration. Persistence materializes
`body_markdown = ydoc.getText('body').toString()` and deliberately does NOT bump
`updated_at` (keeps the REST 409 guard about metadata edits only). Deps: yjs,
y-protocols, lib0, @fastify/websocket. No Bolt event (no catalog entry; omitted).

Client (beacon): CodeMirror 6 + y-codemirror.next co-editor
(`components/editor/markdown-coeditor.tsx`), `hooks/use-collaboration.ts`,
wired into `pages/beacon-editor.tsx` (edit mode → co-editor; create mode keeps
the textarea until an id exists). nginx `/beacon/ws` in all 3 configs; vite
`dedupe: ['yjs']`.

Two bugs surfaced and fixed during the live smoke:

1. **yCollab init desync (client).** Binding CodeMirror to the Y.Text before the
   first sync delivered content left the view blank while the doc filled up.
   Fix: `markdown-coeditor.tsx` creates the EditorView only once the Y.Text has
   content (observe) or a short grace window elapses — at build time `doc`
   always equals the current Y.Text, so no desync. (Note: y-websocket's `sync`
   event does NOT fire reliably against the custom WS server, so gating on it is
   not viable; content-presence is the reliable signal.)

2. **First-client seed never delivered (server).** The connection handler runs
   async auth/seed `await`s before attaching `socket.on('message')`, so the
   y-websocket client's initial sync-step-1 (sent on open) was dropped by `ws`,
   and the server never replied step-2 with the seed — the FIRST client saw a
   blank doc (a second client only worked because a later broadcast carried the
   seed). Fix: after `sendSyncStep1`, the server proactively pushes the full doc
   state as an idempotent update, so existing/seeded content reaches every client
   regardless of message timing.

**Verification:** beacon-api + beacon typecheck clean; 95 beacon-api unit tests
pass; a live two-client Playwright smoke (self-contained: fresh article each run)
passed all of — seeding (existing body loads into the co-editor), second-client
sync, live co-edit (type in client A → appears in client B), and save
materialization (explicit Save writes the live Yjs text to body_markdown).
Smoke script run then deleted.
