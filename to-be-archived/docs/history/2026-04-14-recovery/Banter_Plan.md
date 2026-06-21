# Banter Implementation Plan (2026-04-14)

## Scope

Banter is approximately 64% complete at `f5fb079`. Core messaging infrastructure (channels, DMs, threads, reactions, pins, bookmarks) is fully functional with 15 REST route files, 18 schema tables already present in the tree, and 47 MCP tools. LiveKit voice/video infrastructure is configured with basic call UI. This plan closes P0 gaps in voice agent orchestration, STT transcription pipeline, cross-product embeds, and UI alignment with the BigBlueBam chrome, plus P1 enhancements in screen sharing, recording, link previews, presence, unread sync, message partitioning, and per-channel retention.

**In scope (P0):** AI voice agent pipeline (LiveKit Agents SDK integration, STT/LLM/TTS orchestration); STT transcription pipeline; cross-product rich embeds (Bam tasks, Beacon articles, Bond deals, OG previews); UI alignment with BigBlueBam chrome.

**In scope (P1):** screen sharing track management; call recording + playback; link preview generation; presence state transitions (online/idle/in_call/dnd); unread cursor real-time sync; explicit future-month message partitions; per-channel retention enforcement.

**Out of scope:** Custom emoji library, advanced RBAC beyond owner/admin/member/viewer, Helpdesk integration, Slack/Teams federation, end-to-end encryption, automated channel creation workflows, viewer role UI enforcement beyond schema, granular message edit permissions beyond schema.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | AI voice agent pipeline via LiveKit Agents SDK (STT/LLM/TTS orchestration, MCP tool calling) |
| G2 | P0 | audit §Missing P0 item 2 | STT transcription pipeline. Live + post-call transcripts in `banter_call_transcripts` |
| G3 | P0 | audit §Missing P0 item 3 | Cross-product rich embeds in messages (task, beacon, deal, OG preview) |
| G4 | P0 | audit §Missing P0 item 4 | UI alignment with BigBlueBam chrome (header, sidebar, logo mark, nav links) |
| G5 | P1 | audit §Missing P1 item 1 | Screen sharing UI and track management |
| G6 | P1 | audit §Missing P1 item 2 | Call recording + playback via LiveKit egress to MinIO |
| G7 | P1 | audit §Missing P1 item 3 | Link preview generation (OG metadata fetching and rendering) |
| G8 | P1 | audit §Missing P1 item 4 | Presence state transitions (online/idle/in_call/dnd) with WebSocket broadcast |
| G9 | P1 | audit §Missing P1 item 5 | Unread cursor real-time sync across tabs/sessions |
| G10 | P1 | audit §Missing P1 item 6 | Explicit future-month message partitions (2027-2028) + monthly worker job |
| G11 | P1 | audit §Missing P1 item 7 | Per-channel message retention override enforcement |

## Migrations

**Reserved slots: 0105, 0106, 0107, 0108.**

All 18 Banter schema tables already exist in the committed tree (migrations `0026_banter_tables.sql`, `0027_banter_partitions.sql`, and subsequent Banter-specific files). This plan adds only the new additions for presence, future partitions, and role/edit constraints.

### 0105_banter_user_presence.sql

**Body:**
```sql
-- 0105_banter_user_presence.sql
-- Why: Add real-time user presence tracking table for status broadcast (online, idle, in_call, dnd, offline). Powers presence indicators in sidebar and call UI.
-- Client impact: additive only. New table.

CREATE TABLE IF NOT EXISTS banter_user_presence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'offline',
  in_call_channel_id UUID REFERENCES banter_channels(id) ON DELETE SET NULL,
  custom_status_text VARCHAR(200),
  custom_status_emoji VARCHAR(10),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'banter_user_presence_status_check') THEN
    ALTER TABLE banter_user_presence
      ADD CONSTRAINT banter_user_presence_status_check
      CHECK (status IN ('online', 'idle', 'in_call', 'dnd', 'offline'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_banter_user_presence_user ON banter_user_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_banter_user_presence_status ON banter_user_presence(status) WHERE status != 'offline';
```

### 0106_banter_future_message_partitions.sql

**Body:**
```sql
-- 0106_banter_future_message_partitions.sql
-- Why: Pre-create monthly partitions for 2027 and first half of 2028 so message inserts never hit a missing partition. Worker job creates further partitions on demand.
-- Client impact: none. DDL only.

CREATE TABLE IF NOT EXISTS banter_messages_2027_01 PARTITION OF banter_messages FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_02 PARTITION OF banter_messages FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_03 PARTITION OF banter_messages FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_04 PARTITION OF banter_messages FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_05 PARTITION OF banter_messages FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_06 PARTITION OF banter_messages FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_07 PARTITION OF banter_messages FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_08 PARTITION OF banter_messages FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_09 PARTITION OF banter_messages FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_10 PARTITION OF banter_messages FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_11 PARTITION OF banter_messages FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS banter_messages_2027_12 PARTITION OF banter_messages FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

CREATE TABLE IF NOT EXISTS banter_messages_2028_01 PARTITION OF banter_messages FOR VALUES FROM ('2028-01-01') TO ('2028-02-01');
CREATE TABLE IF NOT EXISTS banter_messages_2028_02 PARTITION OF banter_messages FOR VALUES FROM ('2028-02-01') TO ('2028-03-01');
CREATE TABLE IF NOT EXISTS banter_messages_2028_03 PARTITION OF banter_messages FOR VALUES FROM ('2028-03-01') TO ('2028-04-01');
CREATE TABLE IF NOT EXISTS banter_messages_2028_04 PARTITION OF banter_messages FOR VALUES FROM ('2028-04-01') TO ('2028-05-01');
CREATE TABLE IF NOT EXISTS banter_messages_2028_05 PARTITION OF banter_messages FOR VALUES FROM ('2028-05-01') TO ('2028-06-01');
CREATE TABLE IF NOT EXISTS banter_messages_2028_06 PARTITION OF banter_messages FOR VALUES FROM ('2028-06-01') TO ('2028-07-01');
```

### 0107_banter_channel_viewer_role.sql

**Body:**
```sql
-- 0107_banter_channel_viewer_role.sql
-- Why: Add viewer role to channel_memberships role enum, enabling read-only channel membership. Schema-level support; UI enforcement is follow-on work.
-- Client impact: additive only. Replaces existing role constraint with one that also accepts 'viewer'.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'banter_channel_memberships_role_check') THEN
    ALTER TABLE banter_channel_memberships DROP CONSTRAINT banter_channel_memberships_role_check;
  END IF;
  ALTER TABLE banter_channel_memberships
    ADD CONSTRAINT banter_channel_memberships_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'viewer'));
END $$;
```

### 0108_banter_message_edit_permissions.sql

**Body:**
```sql
-- 0108_banter_message_edit_permissions.sql
-- Why: Add edit_permission column to messages to track who can edit. Schema-level support; UI enforcement is follow-on work.
-- Client impact: additive only. Existing rows default to 'own'.

ALTER TABLE banter_messages
  ADD COLUMN IF NOT EXISTS edit_permission VARCHAR(20) NOT NULL DEFAULT 'own';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'banter_messages_edit_permission_check') THEN
    ALTER TABLE banter_messages
      ADD CONSTRAINT banter_messages_edit_permission_check
      CHECK (edit_permission IN ('own', 'thread_starter', 'none'));
  END IF;
END $$;
```

## Schemas and shared types

- `packages/shared/src/schemas/banter.ts` (new, G4) — `BanterChannelType`, `BanterChannelRole` (including viewer), `BanterPresenceStatus`, `BanterCallType`, `BanterCallStatus`, `BanterParticipationMode`, `BanterContentFormat`, `CreateChannelSchema`, `CreateMessageSchema`, `MessageEmbedSchema` (discriminated union on `embed_type`), `PresenceUpdateSchema`. Exported from `@bigbluebam/shared`.
- `apps/banter-api/src/db/schema/banter-user-presence.ts` (new) — Drizzle table matching migration 0105.
- `apps/banter-api/src/db/schema/banter-channel-memberships.ts` (update) — widen `role` enum type to include 'viewer'.
- `apps/banter-api/src/db/schema/banter-messages.ts` (update) — add `edit_permission` column.

## API routes and services

### New routes

- `POST /me/presence` (G8) in `apps/banter-api/src/routes/presence.routes.ts` — set presence status (online/idle/dnd/offline), optional custom status text/emoji, optional in_call_channel_id.
- `GET /me/presence` (G8) — return current user presence.
- `GET /channels/:id/presence` (G8) — list online/in-call members in channel.
- `GET /calls/:id/recording` (G6) — redirect to presigned MinIO URL for call recording.

### Route updates

- `POST /channels/:id/messages` (G3) — after insert, call `embed-resolver.enrichEmbeds(content)` and update `metadata.embeds` with detected task/beacon/deal/OG previews.
- `PATCH /messages/:id` (G13 schema support) — verify `edit_permission` allows requester.

### New services

- `apps/banter-api/src/services/embed-resolver.ts` (new, G3) — regex-scan message content for URLs. Detect `BBB-\d+` or `/b3/tasks/BBB-\d+` → fetch task from Bam API. Detect `/beacon/articles/...` → fetch beacon. Detect `/bond/deals/...` → fetch deal. Generic `https?://` → fetch OG metadata via cheerio. Cache results in Redis (5 min BBB entities, 10 min OG). Return `metadata.embeds = [{ embed_type, title, description, image_url, url }]`.
- `apps/banter-api/src/services/link-preview.ts` (new, G7) — OG metadata extraction: fetch URL, parse HTML, extract `og:title`, `og:description`, `og:image`, `og:site_name`. Redis cache 1 hour.
- `apps/banter-api/src/services/partition-manager.ts` (new, G10) — for the incoming monthly worker job: query `pg_tables` for existing `banter_messages_YYYY_MM` partitions, compute next needed month, execute `CREATE TABLE ... PARTITION OF banter_messages FOR VALUES FROM (...) TO (...)`.

### Service updates

- `apps/banter-api/src/services/voice-agent-client.ts` (update, G1) — orchestrate LiveKit Agents SDK pipeline:
  1. `registerAgent(callId, userId, mode)` — HTTP POST to `voice-agent:4003` with call metadata, STT/TTS/LLM config from `banter_settings`.
  2. Agent subscribes to all non-agent audio tracks in LiveKit room.
  3. Stream audio to configured STT (Deepgram/Whisper) via provider adapter in `apps/voice-agent/src/stt/`.
  4. Send finalized transcript + history + system prompt to Claude via `@anthropic-ai/sdk`. System prompt advertises all 47 Banter MCP tools as tool definitions.
  5. Stream LLM response to TTS (ElevenLabs/Piper) via provider adapter in `apps/voice-agent/src/tts/`. Route to LiveKit audio track.
  6. Graceful fallback: if STT/TTS unavailable, demote to text mode; post responses as `call.agent_text_message` WebSocket events.
- `apps/banter-api/src/services/transcription.ts` (update, G2) — live transcription during call (subscribe to tracks, stream to STT, insert finalized segments to `banter_call_transcripts`). Post-call transcription worker job: query ended calls with `transcription_enabled=true` and no transcripts, download recording from MinIO, pass to Whisper/Deepgram batch, insert segments.
- `apps/banter-api/src/services/recording.ts` (update, G6) — on call start with `recording_enabled=true`, POST to LiveKit `StartEgressRequest` with ROOM_COMPOSITE layout, store `egress_id`. Webhook handler on `egress_ended` copies output to MinIO `banter/recordings/{org_id}/{call_id}.mp4`, stores presigned URL in `banter_calls.recording_url`.
- `apps/banter-api/src/services/message.service.ts` (update, G3, G11) — `postMessage()` calls `embed-resolver.enrichEmbeds()` before insert. Add `deleteByRetention(channelId)` for per-channel override enforcement.
- `apps/banter-api/src/services/livekit-token.ts` (update, G8) — on participant join webhook, upsert `banter_user_presence` to `in_call` with channel_id; on leave, reset to `online`.

## Frontend pages and components

### New components

- `apps/banter/src/components/presence/user-presence-indicator.tsx` (new, G8) — circular badge (green=online, yellow=idle, blue=in_call, red=dnd, gray=offline).
- `apps/banter/src/components/calls/screen-share-view.tsx` (new, G5) — render screenshare track in expanded view, hide participant grid, show presenter controls.
- `apps/banter/src/components/calls/transcript-view.tsx` (update, G2) — render live + post-call transcripts with speaker, timestamp, confidence. Auto-scroll on new segments.
- `apps/banter/src/components/embeds/task-embed-card.tsx` (new, G3) — Bam task preview: title, status badge, assignee, due date, open-in-BBB link.
- `apps/banter/src/components/embeds/beacon-embed-card.tsx` (new, G3) — Beacon article preview.
- `apps/banter/src/components/embeds/bond-embed-card.tsx` (new, G3) — Bond deal preview.
- `apps/banter/src/components/embeds/og-preview-card.tsx` (new, G7) — OG metadata preview with domain, title, description, image thumbnail.

### New hooks

- `apps/banter/src/hooks/use-presence.ts` (new, G8) — subscribe to WebSocket `presence.changed`, auto-set idle after 5 min inactivity, set in_call on call join.
- `apps/banter/src/hooks/use-screen-share.ts` (new, G5) — start/stop screen share via LiveKit, track sharing state.
- `apps/banter/src/hooks/use-unread-sync.ts` (new, G9) — broadcast `last_read_message_id` updates over WebSocket, receive from other tabs/sessions to avoid stale badges.

### Page updates

- `apps/banter/src/components/layout/banter-layout.tsx` (update, G4) — unified header with cross-app pills (BBB, Banter active, Helpdesk), search input, org switcher, notifications bell, user avatar menu. Sidebar: keep 260px width, add Banter logo mark, role-gated bottom section (SuperUser, People, Settings), remove bottom user-info panel. Add alpha pill next to wordmark.
- `apps/banter/src/components/messages/message-item.tsx` (update, G3, G7) — render `metadata.embeds` loop, switch on `embed_type` to appropriate card component.
- `apps/banter/src/pages/admin.tsx` (update, G1, G2, G6) — add "Voice & Video" admin section: master toggle, LiveKit config, call limits, recording toggle, transcription toggle + STT provider dropdown, AI voice agent toggle + TTS provider + LLM config + greeting. Status badges for each integration.

## Worker jobs

### `apps/worker/src/jobs/banter-transcription.job.ts` (new, G2)

Trigger: hourly. Query `banter_calls WHERE transcription_enabled=true AND ended_at < NOW() - INTERVAL '1 hour' AND NOT EXISTS (SELECT 1 FROM banter_call_transcripts WHERE call_id = banter_calls.id)`. Download recording from MinIO, batch-transcribe via Whisper/Deepgram, insert segments.

### `apps/worker/src/jobs/banter-partition-monthly.job.ts` (new, G10)

Trigger: daily 2 AM UTC. Call `partition-manager.ensureNextMonthPartition()`. Creates next month's `banter_messages_YYYY_MM` if missing.

### `apps/worker/src/jobs/banter-retention.job.ts` (update, G11)

Trigger: daily 1 AM UTC. For each channel with `message_retention_days > 0` (per-channel override), soft-delete messages older than the threshold; after 30-day grace, hard-delete.

### `apps/worker/src/jobs/banter-presence-sync.job.ts` (new, G8)

Trigger: every 5 minutes. Query `banter_user_presence WHERE updated_at < NOW() - INTERVAL '30 minutes'`. Set status to 'offline', broadcast `presence.changed` event.

Register all four jobs in `apps/worker/src/index.ts` with BullMQ repeating patterns.

## MCP tools

No new tools beyond the 47 documented. Existing tools updated:

- `banter_join_call` — accept `mode: 'voice'|'text'` to spawn voice agent or join as text participant.
- `banter_post_message` — rely on new `embed-resolver` for auto-enrichment; no input change.
- `banter_search_transcripts` — new alias path for the transcript search endpoint (tsvector GIN index already exists).

## Tests

- `apps/banter-api/src/services/__tests__/embed-resolver.test.ts` (new, G3) — detects `BBB-NNN`, beacon URLs, bond URLs, OG fallback; metadata enrichment correctness.
- `apps/banter-api/src/services/__tests__/transcription.test.ts` (new, G2) — STT provider routing, segment insertion, post-call batch path.
- `apps/banter-api/src/services/__tests__/recording.test.ts` (new, G6) — egress request to LiveKit (mocked), webhook handling on `egress_ended`, MinIO upload and presigned URL.
- `apps/banter-api/src/services/__tests__/voice-agent-client.test.ts` (new, G1) — agent registration, STT/LLM/TTS pipeline happy path, graceful fallback to text mode.
- `apps/banter-api/src/services/__tests__/partition-manager.test.ts` (new, G10) — create missing partition, skip if exists.
- `apps/banter-api/src/routes/__tests__/presence.test.ts` (new, G8) — set/get presence, idle timeout simulation.
- `apps/worker/src/jobs/__tests__/banter-transcription.test.ts` (new, G2) — queries ended calls, downloads recording, inserts segments.
- `apps/worker/src/jobs/__tests__/banter-partition-monthly.test.ts` (new, G10).
- `apps/worker/src/jobs/__tests__/banter-retention.test.ts` (new, G11) — per-channel retention enforcement, soft and hard delete.
- `apps/banter/src/components/__tests__/message-item.test.tsx` (new, G3, G7) — renders embeds from metadata.
- `apps/banter/src/components/__tests__/banter-layout.test.tsx` (new, G4) — unified header renders, sidebar role gating.
- `apps/banter/src/hooks/__tests__/use-presence.test.ts` (new, G8).
- `apps/banter/src/hooks/__tests__/use-screen-share.test.ts` (new, G5).

## Verification steps

```bash
pnpm --filter @bigbluebam/shared build
pnpm --filter @bigbluebam/banter-api build
pnpm --filter @bigbluebam/banter-api typecheck
pnpm --filter @bigbluebam/banter-api test
pnpm --filter @bigbluebam/banter typecheck
pnpm --filter @bigbluebam/banter test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-banter-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55496:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55496/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55496/verify' pnpm db:check
docker rm -f bbb-banter-verify
```

**Live smoke tests:** create a call with `transcription_enabled=true`, speak, end call, verify transcripts populated; post a message containing `BBB-142` and a generic URL, verify embed cards render; set presence to `dnd`, verify broadcast and indicator update; join a call, verify presence flips to `in_call` with channel_id; test screen share start/stop; test call recording start, end, playback link; verify unified header and sidebar match BigBlueBam chrome.

## Out of scope

Custom emoji library and management UI, advanced RBAC beyond viewer role, Helpdesk integration, Slack/Teams federation, end-to-end encryption, automated channel creation, viewer role UI enforcement beyond schema, granular message edit permission UI enforcement beyond schema, call analytics dashboard, message search across orgs, automated moderation.

## Dependencies

- LiveKit SFU (existing, ports 7880/7881/7882).
- voice-agent container at `voice-agent:4003` (existing Python/FastAPI placeholder; this plan adds real STT/LLM/TTS providers).
- STT provider: Deepgram or Whisper (configurable via `STT_PROVIDER` env var).
- TTS provider: ElevenLabs or Piper (configurable via `TTS_PROVIDER`).
- `@anthropic-ai/sdk` for voice agent LLM orchestration.
- `cheerio` for OG metadata extraction.
- MinIO `banter/recordings/` bucket prefix for call recordings.
- Bam API (internal :4000), Beacon API (internal :4004), Bond API (internal :4009) for embed resolution.
- Redis (existing) for embed-resolver and link-preview caching and presence pub/sub.

**Migration numbers claimed: 0105, 0106, 0107, 0108.**
