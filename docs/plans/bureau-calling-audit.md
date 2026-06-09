# Bureau Prerequisite — Calling Audit

**Date:** 2026-06-09
**Scope:** Audit of every existing calling/voice/video surface across the BigBlueBam suite, executed before the Bureau feature begins. Bureau composes existing pieces (Banter presence, Board call rooms, Brief call rooms, LiveKit SFU, voice-agent). The pieces must work first.

This document is the source of truth for what is wired today, what is broken, what is missing, and what needs to land before Bureau §3-onwards can build on solid ground.

---

## 1. Per-app status

### Banter (`apps/banter/`, `apps/banter-api/`)  — ✅ 85% wired

Calls work end-to-end for the happy path. Token mint, LiveKit join, mute/cam, participant tracking, leave/end are all functional. The voice-agent service is reachable and configured per-org.

The gaps that matter:

| # | Gap | File:line | Severity |
|---|-----|-----------|----------|
| B-1 | `voice_video_enabled` flag in `banter_settings` is not checked on `POST /channels/:id/calls` | `apps/banter-api/src/routes/call.routes.ts` (entire call-create handler) | ❌ Blocker |
| B-2 | Zero UI for any of the 13 calling knobs in `banter_settings` (recording, transcription, agent enable, STT/LLM/TTS provider config, max participants, max duration, etc.) | `apps/banter/` — no settings page | ❌ Blocker |
| B-3 | Incoming-call overlay (`incoming-call-overlay.tsx`) is UI-only — no signaling layer rings a target user when a 1:1/huddle call starts | `apps/banter/src/components/calls/incoming-call-overlay.tsx` | ⚠️ Half-wired |
| B-4 | Agent-text-sidebar (`agent-text-sidebar.tsx`) is UI-only — `onSendMessage` has no backend | `apps/banter/src/components/calls/agent-text-sidebar.tsx` | ⚠️ Half-wired |
| B-5 | `useLiveKit.ts` has a hardcoded `ws://localhost:7880` fallback (should always trust API-returned `livekit_url`) | `apps/banter/src/hooks/use-livekit.ts:36` | ⚠️ Polish |
| B-6 | Recording requires S3 config; Egress failures are caught + logged but never surfaced to the user (silent failure) | `apps/banter-api/src/services/recording.ts:40-48`, `call.routes.ts:726` | ⚠️ Polish |
| B-7 | Transcription has DB schema (`banter_call_transcripts`) but no webhook handler accepts STT segments | (no file — endpoint missing) | ❌ Missing feature |

**LiveKit credentials live in `banter_settings`** (`livekit_host`, `livekit_api_key`, `livekit_api_secret`) per-org with SSRF guard and secret masking. Falls back to env. This is the existing per-org credential store; Bureau and Board/Brief will share it.

### Board (`apps/board/`, `apps/board-api/`)  — ✅ ~50% wired (audio only)

Audio works in canvas. Token mint via `apps/board-api/src/services/livekit.service.ts`, room name `board-{boardId}`, mute/speaking indicator/participant count UI present. Visibility-based ACL.

| # | Gap | File:line | Severity |
|---|-----|-----------|----------|
| BD-1 | **Does not honor `?lkRoom=` query parameter** → blocks Bureau §9 Strategy B (continuous-audio teleport) | `apps/board/src/hooks/use-audio.ts:24-31`, `apps/board/src/app.tsx:34-56` | ❌ Bureau blocker |
| BD-2 | Audio-only — no video, no screen share. Bureau design says "voice / video transport" so video would unlock per-room office calls | `apps/board/src/components/canvas/audio-controls.tsx:101-154` | ⚠️ Future |
| BD-3 | No call-related DB tables or audit (ephemeral LiveKit-only) | `apps/board-api/src/db/schema/` | ✅ Acceptable |
| BD-4 | Per-org audio enable/disable not gated — silent inheritance of LiveKit availability | `apps/board-api/src/routes/audio.routes.ts:17-151` | ⚠️ Polish |

### Brief (`apps/brief/`, `apps/brief-api/`)  — ❌ 0% (no LiveKit)

The design doc claims "Brief auto-joins `brief-{docId}`." That is aspirational — the implementation does not exist:

- No LiveKit dependency in `apps/brief/package.json`.
- No call panel, no mute/cam controls, no participant indicator in `apps/brief/src/components/`.
- No token endpoint in `apps/brief-api/src/routes/`.
- No `LIVEKIT_*` env vars in `apps/brief-api/src/env.ts`.
- No `livekit_room_name` column on `brief_documents`.
- Existing collaboration is Tiptap + Yjs (a separate workstream that itself is paused).

For Bureau Strategy B to target a Brief doc with continuous audio, Brief needs the full LiveKit auto-join stack added. This is workstream BR-1 below.

### Book (`apps/book-api/`)  — ⚠️ Calling tie-in absent

`book_events.meeting_url` exists as a freeform link column. There is no automatic LiveKit room creation on booking, no "join meeting" button that routes to a LiveKit room, no integration with the voice-agent. Bureau §16 delegates conference-room reservations to Book; today Book has zero call awareness.

| # | Gap | Severity |
|---|-----|----------|
| BK-1 | No auto-room creation on booking confirmation | ⚠️ Bureau §4-§13 wants this |
| BK-2 | `meeting_url` is plaintext / external; no LiveKit binding | ⚠️ |

### voice-agent (`apps/voice-agent/`, Python LiveKit Agents SDK)  — ⚠️ functional / centrally configured

The service runs, has `POST /agents/spawn` + `POST /agents/{id}/despawn` + `GET /agents/{id}/status` endpoints, Redis-backed cross-pod state, orphan reconciliation on startup, graceful degradation if `livekit-agents` SDK isn't installed.

Config is **platform-wide env-only**. STT/LLM/TTS providers are env vars; banter-api pushes per-org config via `POST /config` but the agent treats it as a global mutable state. There is no per-org config persistence — a restart loses customizations.

| # | Gap | Severity |
|---|-----|----------|
| VA-1 | No per-org STT/LLM/TTS persistence (in-memory only) | ⚠️ |
| VA-2 | No metrics / SLO tracking | Polish |

### packages/livekit-tokens  — ✅ ready

`mintRoomToken()` handles every existing case. Room-naming helper `buildAppRoomName()` already accepts an `app` string — Bureau can pass `'bureau'` directly. Bureau will need a room-admin grant exposed; trivial extension.

### infra/livekit  — ✅ deployed

SFU at `:7880`, webhook URL pointing at banter-api, credentials rendered into `.env` at deploy time, single instance per stack. Per-org credential override happens in `banter_settings.livekit_*`.

### Other 11 SPAs (B3, Beacon, Bearing, Bench, Bill, Blank, Blast, Blueprint, Bolt, Bond, Book, Helpdesk)

None have any calling integration today. All will receive calling functionality only via the bureau-client SDK once Bureau ships. No regressions to worry about — there's nothing to regress.

---

## 2. The settings gap (THE primary blocker)

Banter has 13 calling/agent knobs in its `banter_settings` table, no admin UI surfaces any of them. Board has zero per-org calling settings at all. There is no SuperUser-level surface for platform-wide LiveKit defaults. There is no per-project calling policy anywhere.

The user explicitly asked for "support for configuring that in settings (configured at the Superuser and project on down)." This is the work that has to happen before Bureau can be built — Bureau will read the same configuration, and the UI needs to exist so a deployer can verify their LiveKit is wired before Bureau goes live.

### Proposed hierarchy (decided)

```
┌─────────────────────────────────────────────────────────────────┐
│ SuperUser → Platform Calling Settings                           │
│   - Default LiveKit URL / api_key / api_secret                  │
│   - Default voice-agent URL                                     │
│   - Default STT/LLM/TTS providers (platform-wide fallback)      │
│   - Global calling enable kill-switch                           │
│   - Storage: system_settings table (already-existing)           │
└───────────────────────────┬─────────────────────────────────────┘
                            │ inherits ↓
┌─────────────────────────────────────────────────────────────────┐
│ Org Admin → Org Calling Settings                                │
│   - Per-org LiveKit override (use platform default OR bring     │
│     own LiveKit Cloud creds)                                    │
│   - voice_video_enabled (master toggle for the org)             │
│   - allow_recording, allow_transcription                        │
│   - Per-org STT/LLM/TTS provider override                       │
│   - Max participants, max duration                              │
│   - Storage: banter_settings.* (existing, extended)             │
│       PLUS a small board_settings + brief_settings JSONB if     │
│       Board/Brief need per-org calling-specific overrides       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ inherits ↓
┌─────────────────────────────────────────────────────────────────┐
│ Per-project (Bam-level project_settings)                        │
│   - calling_enabled (override for sensitive projects)           │
│   - allow_recording_for_this_project                            │
│   - Default office privacy when Bureau lands                    │
│   - Storage: NEW project_calling_settings table OR              │
│     projects.settings JSONB column (idempotent)                 │
└─────────────────────────────────────────────────────────────────┘
```

The inheritance is read-time: a call route asks "is calling enabled for this project?" — service walks project → org → platform and returns the most specific value.

---

## 3. Workstreams that gate Bureau

Before the bureau-api skeleton (workstream 1 of the design doc), these prerequisite items must land. Each is small relative to Bureau itself.

| # | Workstream | Effort | Blocks |
|---|-----------|--------|--------|
| **P-1** | Fix Banter's `voice_video_enabled` server-side enforcement (1-line gate in `call.routes.ts`) | 30 min | Bureau §3 — Banter is the presence primitive |
| **P-2** | Build SuperUser Platform Calling Settings page (LiveKit URL/key/secret, voice-agent URL, global enable kill switch) | 1 day | Operator can't configure the system today |
| **P-3** | Build Org Admin Calling Settings page (surfaces all 13 existing knobs in `banter_settings`, plus tabs for Board/Brief overrides if needed) | 1-1.5 days | Per-org admin currently helpless |
| **P-4** | Build Per-project Calling Settings (new `project_calling_settings` row, inheritance lookup helper, UI tab in project settings) | 1 day | User asked for it explicitly |
| **P-5** | Implement Board `?lkRoom=` query parameter handling — fall back to `board-{boardId}` when absent | 2 hours | Bureau §9 Strategy B |
| **P-6** | Implement Brief LiveKit auto-join (`brief-{docId}`) + `?lkRoom=` honoring | 2-3 days | Bureau §9 Strategy B |
| **P-7** | Surface platform-level LiveKit credential rotation/health in SuperUser console | 0.5 day | Operator visibility |
| **P-8** | Smoke-test calling end-to-end after each fix and capture screenshots in `docs/plans/bureau-calling-smoke-tests.md` | 0.5 day | Validation |

**Total prerequisite effort:** ~7-9 days for one focused builder.

---

## 4. Decisions made in this audit (forks closed)

These were judgment calls made by the auditor; document them so anyone returning to the work has the rationale and can revisit if needed.

1. **Per-org LiveKit credentials live in `banter_settings`, not in a new shared table.** Banter already has them, SSRF-guarded and masked. Bureau, Board, and Brief read from the same row. Pro: no migration to move existing values. Con: the column is called `banter_settings` which is misleading naming. We accept the misnomer because the alternative — migrate everything to `org_calling_settings` — is invasive and adds zero behavior.

2. **SuperUser platform defaults live in `system_settings` rows under a new `calling.*` key prefix.** `system_settings` already exists with audit logging and a route framework. Adding `calling.livekit_host`, `calling.livekit_api_key` (encrypted), `calling.voice_agent_url`, `calling.global_enabled` follows that pattern.

3. **Per-project calling settings get their own table (`project_calling_settings`).** A JSONB on `projects` would be simpler but less queryable. Bench will want to roll up "which projects have recording disabled" later, and that's easier off a typed table.

4. **Read-time inheritance, not write-time propagation.** A call route reads project → org → platform live. No background job copies platform defaults into each project on settings change. Simpler, no drift.

5. **Brief calling is its own track, not part of Bureau v1.** The design doc claims Brief auto-joins; the audit shows it doesn't. We will add a `?lkRoom=` honoring stub to Brief (P-6) so summons to a Brief doc can carry continuous audio even before Brief has its own native call panel. Brief's native call panel is a separate workstream that does not gate Bureau v1.

6. **voice-agent per-org config persistence is deferred.** Today it's in-memory; banter-api pushes on every admin settings change. That's fragile but acceptable for v1 — a restart re-reads from the per-org banter-api on first agent spawn. Persistence becomes part of Bureau §15 (Tests + security audit) workstream.

---

## 5. Recommended execution order

1. **P-1, P-5** in parallel (30 min + 2 hours) — fast wins that prove the audit findings.
2. **P-2** (SuperUser platform settings) — unblocks operator configuration.
3. **P-3** (Org admin settings) + **P-7** (credential health) in parallel.
4. **P-4** (per-project settings).
5. **P-8** smoke tests end-to-end with screenshots.
6. **P-6** (Brief LiveKit) — can be deferred until just before Bureau §9 work begins.
7. Then begin Bureau §17 workstream 1.

This plan exits the calling-prerequisite phase with: SuperUser can configure LiveKit credentials with a UI; org admins can toggle calling features per-org; project owners can disable calling on sensitive projects; Banter enforces the org gate; Board supports the continuous-audio handoff; Brief can be teleported to without dropping audio. That's the foundation Bureau actually needs.
