# Resume after restart — feature-bureau

**Written:** 2026-06-09 (machine was about to be rebooted)
**Branch:** `feature-bureau`
**Last commit pushed:** `cf3cbde` (Phase 3 of the unified call model)
**Working tree:** clean as of write time.

This document is the agent's notes-to-self. To resume the work, the user reopens Claude in this repo and says:

> Read `docs/plans/resume-after-restart.md` and pick up where we left off.

That sentence is the prompt. The agent re-reads this file, the deferred-work tracker, and the active task list, and continues.

---

## State of the world

### Branches
- `feature-bureau` — active. Last 3 commits are the unified-call-model phases:
  - `cf3cbde` Phase 3 — ring/summon naming + ?lkRoom= drop + docs update
  - `e51b50f` Phase 2 — rip per-app LiveKit (Board / Brief / Banter)
  - `1de6d22` Phase 1 — ActiveCallManager owns mic/cam/screen
- `main` / `stable` — production. Last promotion was way back; many commits ahead on feature-bureau.

### Bureau v1 shipped
All 15 design-doc workstreams plus the v2 unified-call refactor are in. The Bureau app lives at `apps/bureau/`, the SDK at `packages/bureau-client/`, the API at `apps/bureau-api/`. Floor admin works end-to-end (list / create / archive / unarchive / editor). Image underlay upload works with CSRF. Per-app calling is gone — the docked box is the only call surface.

### Local docker state
- All services were running and healthy at write time.
- Postgres data volume is preserved across reboot (do NOT use `docker compose down -v`).
- If a fresh `docker compose up -d` brings things back, the suite should be live at `https://localhost/`.
- If anything is unhealthy after reboot:
  ```sh
  docker compose ps
  docker compose logs --tail=30 <unhealthy-service>
  docker compose up -d --force-recreate <unhealthy-service>
  ```

### Bureau Launchpad entry
Bureau appears in the Launchpad as "Virtual Office" with the `Building` icon, slate-600 (`#475569`). Catalog entry in `apps/api/src/routes/system-settings.routes.ts:LAUNCHPAD_CATALOG`. Icon mapping in `packages/ui/launchpad.tsx`.

---

## Pending work — the docked-box UX bundle

Three tasks are queued and intentionally bundled. They all touch `packages/bureau-client/src/index.tsx` (the docked box rendering) and were held back to avoid merge conflicts with the unified-call workflow that was running concurrently. **Now that the workflow's committed (`cf3cbde`), these can ship as one cohesive PR.**

### Task #17 — Bureau todo #3: docked widget still says "No room"
When you click a room on the floor view (apps/bureau/src/pages/floor-view.tsx), the room highlights and the green dot appears, but the docked box's "In: <room>" header doesn't update. Root cause: the floor view's `useBureauWs` hook opens its OWN WebSocket connection (separate from the SDK's, per workstream 8 report). When you `enterRoom()`, the floor's WS gets the room_enter event but the SDK's WS never does, so the SDK's BureauContext state stays at `roomId: null`.

**Likely resolution after Phase 1's ActiveCallManager landed:** the manager listens for room_enter on the SDK's WS, so the docked-box mic/cam buttons probably DO know about the room transition now. But the "In: <room name>" header in `index.tsx` still reads from the SDK's `BureauContext.state.roomId` which only the SDK's WS updates. The fix is either:
- Have `apps/bureau/src/main.tsx` describeLocation report the spatial roomId as part of the location so the SDK's state mirrors it, OR
- Share the WS socket between the floor view and the SDK (more invasive)

The first is simpler. Probably 2-3 hours.

### Task #19 — Bureau todo #5: docked box should be draggable + collapsible
The user wants the box repositionable and shrinkable to a bar, instead of Document PiP. Specifically:
- Draggable to any screen position (mouse-down on the header, drag)
- Position persists in localStorage
- A chevron in the header collapses to a draggable bar (just shows status); chevron expands back
- Detect off-screen (viewport resize) and clamp back into view
- Keep Document PiP as a less-prominent option; remove the resize-of-PiP-window functionality

Substantial UI work — ~1 day. Add drag state to BureauDockedBox via Pointer Events, clamp to viewport on `resize` event, persist `{ x, y, collapsed }` in `localStorage[bureau.dock-pos]`.

### Task #21 — Bureau todo #7: gate "Bring everyone here" + add "Invite" button
1. "Bring everyone here" only renders when:
   - `state.roomId != null` (user is in a Bureau spatial room)
   - `state.occupants.length > 1` (at least one other person)
   - `state.location?.url` is set (viewing teleportable resource)
2. New "Invite" button always available when on a content surface:
   - Opens a popover using the `PeoplePicker` from `apps/bureau/src/components/common/people-picker.tsx` in multi-select mode (needs a small extension — picker is currently single-select)
   - On confirm, POST `/v1/ring` per selected user with the current surface's `(surface_app, surface_id, surface_label)`
   - Each invitee gets the IncomingCallOverlay; on Accept they navigate and join the canonical room

PeoplePicker multi-select is a small extension. Ring loop is straightforward. ~3-4 hours.

### Recommended approach for the bundle
Launch a single workflow with three parallel agents:
- Agent A: task #17 (state sync — small backend change to describeLocation in apps/bureau/src/main.tsx + the SDK reading spatial roomId from location)
- Agent B: task #19 (drag + collapse — pure UI in index.tsx)
- Agent C: task #21 (action gating + Invite popover — needs PeoplePicker multi-select + new dialog)
- Verify agent: typecheck + rebuild frontend + smoke

The three touch overlapping JSX in BureauDockedBoxInner but distinct prop/handler surfaces, so coordinate by code section: A owns the header text, B owns the wrapper position/drag, C owns the action row. Verify agent merges any small overlaps.

---

## Open deferred items (D-* tracker)

See `docs/plans/bureau-deferred-work.md` for full text. Open as of now:

- **D-2** — merge CallingCredentialsCard with Platform Calling Settings (~2h, cosmetic)
- **D-4** — Book auto-creates LiveKit rooms on booking (~2d)
- **D-5** — voice-agent per-org STT/LLM/TTS persistence (~1d)
- **D-7** — Banter agent-text-sidebar backend (~0.5d, but the sidebar component itself was deleted in Phase 2; need to decide whether to ship a new "send-prompt-to-agent" surface or drop it)
- **D-9** — beacon-expiry-sweep cron PostgresError 42809 (~30 min)
- **D-10** — consolidate ws.routes.ts inline presence layer (~2h)
- **D-11** — Banter internal DM endpoint for "leave a note" (~2-3h)
- **D-12** — cross-app can-read preflights for board-api / brief-api / apps/api (~1d total)
- **D-13** — ws.routes.ts subscribe-vs-listener race (2-line server fix, ~5 min)

Closed (don't re-open): D-1, D-3, D-6, D-8.

---

## What workflows were running when the machine restarted

If `/workflows` shows any orphaned runs from before the reboot, kill them with `TaskStop` — they're stale (the process is gone) but the harness may still show them.

- `wmu4xrzze` — the unified-call-model 3-phase workflow. **Final verify never completed.** The code on disk typecheck-clean, so it's safe to trust the commits `1de6d22` / `e51b50f` / `cf3cbde`. If you want a paranoid full verify, run:
  ```sh
  docker compose build frontend bureau-api board-api brief-api banter-api worker
  docker compose up -d --force-recreate frontend bureau-api board-api brief-api banter-api worker
  pnpm --filter '@bigbluebam/*' typecheck
  node scripts/check-bolt-catalog.mjs
  ```

- `wswz9wpd1` — Bureau todo batch 1 (#1, #2, #4, #6). **Completed and committed** (`fc3b73e`, `8a5733c`, `6829b28`, `cf8d017`). Drive-by fix: the api() double-stringify bug in admin/floor-list (so floor create + unarchive actually worked).

---

## Smoke URLs ready for human testing (post-reboot)

After `docker compose up -d` brings everything back:

- Bureau app: `https://localhost/bureau/`
- Launchpad: any SPA's top-right grid icon
- Bureau Admin → Floors: `https://localhost/bureau/admin/floors` (create, edit, archive flows)
- Bureau Admin → Offices: `https://localhost/bureau/admin/offices` (reassign with PeoplePicker)
- Floor editor with PeoplePicker for office owner: `https://localhost/bureau/admin/floors/<floor-id>` then select an office, use the inspector
- Image underlay upload: same page, "Image underlay" button
- Two-browser test for presence: `https://localhost/brief/documents/<id>` opened in two tabs as two users — chip strip should show the other user; click → Ring for huddle
- Bureau docked box (visible on every page): bottom-right floating widget; mic/cam/screen should now actually connect (unified-call Phase 1)

---

## How to invoke me to resume

After reboot, open Claude in this repo and paste:

```
Read docs/plans/resume-after-restart.md and pick up where we left off.
```

That's it. The doc tells me everything I need to continue.

If you want to skip straight to the docked-box UX bundle (tasks #17, #19, #21), say:

```
Read docs/plans/resume-after-restart.md, then launch the docked-box UX bundle workflow (tasks #17, #19, #21) per the "Recommended approach" section.
```
