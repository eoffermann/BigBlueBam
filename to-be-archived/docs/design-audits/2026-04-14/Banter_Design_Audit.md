# Banter Design Audit (2026-04-14)

## Summary

Banter's implementation delivers a solid foundation for real-time team messaging and AI collaboration. The core messaging layer (channels, DMs, threads, reactions, pins) is substantially complete, with 16 API routes, 18 schema tables, and 52 MCP tools. Audio/video infrastructure via LiveKit is correctly configured, and suite integration with BigBlueBam (via metadata, Bolt enrichment, task references) is architected but only partially realized. The frontend (7 pages, 18 components, 12 hooks) covers essential messaging UI. Critical gaps remain in advanced voice features (agent voice pipeline, transcription, STT/TTS integration), UI alignment with BigBlueBam, and background job coverage for notifications and message retention. Overall completion: approximately 64%.

## Design sources consulted

- `docs/early-design-documents/Banter_Design_Document.md` (v1.0, ~1200 lines)
- `docs/banter-ui-alignment-plan.md` (supplemental UI alignment notes)
- `docs/design-audits/2026-04-09/Banter-Design-Audit-2026-04-09.md` if it exists
- `CLAUDE.md`
- `infra/livekit/livekit.yaml` (SFU configuration)

## Built and working

### Data model

All 18 Banter tables declared in Drizzle ORM:
- `banter_channels`, `banter_channel_groups`, `banter_channel_memberships`
- `banter_messages`, `banter_message_attachments`, `banter_message_reactions`
- `banter_pins`, `banter_bookmarks`
- `banter_calls`, `banter_call_participants`, `banter_call_transcripts`
- `banter_user_groups`, `banter_user_group_memberships`
- `banter_user_preferences`, `banter_settings`
- `banter_audit_log`

Key design choices verified:
- Channel types (public, private, dm, group_dm) with org scoping
- Messages partitioned by created_at (monthly range partitions)
- Message `metadata` JSONB for suite references (task links, Bolt embeds)
- Call model supports voice, video, huddle types with LiveKit room naming convention
- User preferences include Banter-specific settings (enter_sends_message, auto_join_huddles, noise_suppression)
- Denormalized fields (message_count, member_count, last_message_at) for UI performance

No migration files specific to Banter in `infra/postgres/migrations/`. Schema may be in baseline 0000_init.sql or seed data. Partition strategy should be verified with `pnpm db:check`.

`@types/dompurify` stub was removed in commit `eb12baa` per prior audit. Verified clean at a8fb19a.

### REST API routes

Banter API exposes 16 route files:
1. `channel.routes.ts` - CRUD, membership, listing
2. `dm.routes.ts` - 1-to-1 and group DMs
3. `message.routes.ts` - post, edit, delete, list with pagination
4. `thread.routes.ts` - threaded replies
5. `reaction.routes.ts` - emoji reactions with toggle semantics
6. `pin.routes.ts` - pin/unpin messages
7. `bookmark.routes.ts` - user-level message saves
8. `call.routes.ts` - voice/video/huddle initiation, participant tracking
9. `user-group.routes.ts` - create, list, manage members
10. `preference.routes.ts` - per-user notification/UI settings
11. `search.routes.ts` - message search
12. `file.routes.ts` - attachment upload, MinIO integration
13. `admin.routes.ts` - org-wide settings, channel management
14. `user.routes.ts` - user lookup by email, handle
15. `webhook.routes.ts` - LiveKit event webhooks
16. `internal.routes.ts` - health checks, internal ops

API features verified:
- Cursor-based pagination
- Per-route rate limiting (POST message 30/min, file upload 10/min, channel create 5/hr)
- Shared auth (session + API key)
- Standardized error envelope
- Zod validation via `@bigbluebam/shared` schemas

### Voice and video (LiveKit Layer 1)

- LiveKit SFU configured in `infra/livekit/livekit.yaml` (port 7880 signaling, 7881 TURN/TCP, UDP 50000-50100 for media)
- Webhook endpoint at `POST /v1/webhooks/livekit` for LiveKit event callbacks
- Call initiation via `POST /v1/channels/:id/calls` with type, recording/transcription flags, AI agent mode
- Participant tracking in `banter_call_participants` with audio/video/screen-share flags
- Client SDK integration in `use-livekit.ts`, `call-panel.tsx`, `video-grid.tsx`

### MCP tools

52 Banter MCP tools in `apps/mcp-server/src/tools/banter-tools.ts`:
- Channels (10): list, get, by-name, create, update, archive, delete, join, leave, add/remove members
- Messages (8): list, get, post, edit, delete
- Threads (3): list replies, post reply, send to channel
- Reactions (2): add, remove
- Pins (2): add, remove
- Bookmarks (2): add, remove
- Calls (3): start, join, end
- User Groups (4): list, create, update, delete
- Search (4): channels, messages, users, threads
- User Lookup (3): by-id, by-email, by-handle
- Settings (3): org settings, channel group settings, user preferences
- Misc (3): user info, resolve identities, list pinned

All tools support name-or-ID resolution. Destructive operations use two-step confirmation pattern.

### Frontend (7 pages, 18 components, 12 hooks)

Pages: `banter-layout.tsx`, `channel-view.tsx`, `channel-browser.tsx`, `search.tsx`, `bookmarks.tsx`, `preferences.tsx`, `admin.tsx`.

Components (18): layout (banter-sidebar, notifications-bell, org-switcher, user-menu), messages (message-item, message-timeline, message-compose, typing-indicator), threads (thread-panel), calls (call-panel, video-grid, huddle-banner, incoming-call-overlay, device-settings-dialog, agent-text-sidebar, transcript-view), common (user-profile-popover).

Hooks (12): use-channels, use-messages, use-threads, use-reactions, use-unread, use-realtime, use-typing, use-presence, use-livekit, use-call, use-devices, use-keyboard-shortcuts.

Total frontend LOC: 4,634.

### WebSocket real-time

Banter WebSocket handler at `apps/banter-api/src/ws/handler.ts` manages:
- Message posting and reactions (broadcast to channel room)
- Presence updates (user online/idle/in-call)
- Typing indicators (per-channel with debounce)
- Call signaling (participant list, connection events)

Redis PubSub used for cross-instance broadcasting. Native WebSocket with Redis fallback. Per-channel rooms scoped by org.

### Background jobs

Two BullMQ job handlers in `apps/worker/src/jobs/`:
- `banter-notification.job.ts` (176 lines) - mention notifications, notification queue delivery
- `banter-retention.job.ts` (71 lines) - message retention policy (delete messages older than `message_retention_days`)

## Partial or divergent

### Voice Layer 2 (transcription)

Declared but not functional:
- `banter_call_transcripts` table exists with speaker, utterance timing, STT confidence columns.
- No STT service integration.
- `transcription_enabled` flag on calls is accepted but transcripts never populated.
- Post-call transcript generation and storage-key assignment missing.

### Voice Layer 3 (AI voice agent)

Placeholder only:
- `apps/voice-agent/` is a Python Docker container (Dockerfile, requirements.txt, minimal src/)
- Design specifies LiveKit Agents SDK STT -> LLM -> TTS pipeline; container not wired to any orchestration
- Endpoints for voice agent mode on calls exist but agent does not join LiveKit rooms
- Text-only fallback (agent responses in call chat sidebar) is not yet implemented
- `voice-agent-client.ts` exists but only imports configuration; no actual SDK calls or session management

### UI alignment with BigBlueBam

Per `docs/banter-ui-alignment-plan.md`:
- Cross-app navigation bar (BBB, Banter, Helpdesk pills) not integrated with Banter header
- Org switcher, search input, notifications bell, user avatar menu present in BBB header but missing from Banter
- Sidebar width (260px) should match BBB (240px)
- No Banter logo mark
- Role-gated links (SuperUser, All Users, People) not present in Banter sidebar
- Bottom user-info panel should move to header avatar menu

### Call recording and playback

- `recording_enabled` flag exists in call schema
- LiveKit egress not configured for recording
- No download/playback routes for recorded calls

### Suite integration (partial)

- Message `metadata` JSONB column for suite references exists
- Bolt enrichment helpers (`bolt-enrich.ts`) to populate event payloads
- Bolt event catalog mentions `banter.message.posted`, `banter.message.replied`, `banter.call.started`
- NOT yet integrated: rich embeds for task links (interactive cards), link preview generation (OG metadata), Beacon search/indexing of message content, Bam task update notifications in Banter channels

## Missing

### P0

1. **AI voice agent pipeline** (Layer 3). LiveKit Agents SDK, STT -> LLM -> TTS integration, voice-agent container orchestration, MCP tools for agent voice state.
2. **STT transcription pipeline** (Layer 2). Integration with Deepgram, Whisper, or similar. Post-call job to generate transcripts and link to calls.
3. **Cross-product rich embeds**. Interactive cards showing task title/status/assignee when message contains task link.
4. **UI alignment with BigBlueBam**. Unified header, sidebar, navigation per `banter-ui-alignment-plan.md`.

### P1

5. **Screen sharing UI and track management** on client.
6. **Call recording and playback** - egress to MinIO, download URL.
7. **Link preview generation** - OG metadata fetching for URLs in messages.
8. **Presence state transitions** - online -> idle on inactivity, online -> in_call on call join wired to client lifecycle.
9. **Unread cursor real-time sync** - last_read_message_id broadcast to other tabs/sessions.
10. **Explicit message partition migration** - create monthly range partitions for `banter_messages` via migration.
11. **Message retention per-channel override** - channel-specific retention policy.

### P2

12. **Viewer role restrictions** on channel access.
13. **Granular message editing permissions** (own/thread-starter only).
14. **Bulk message operations**.
15. **Frontend test coverage** - zero test files in `apps/banter/src/`.

## Architectural guidance

### Voice agent pipeline

Wire up the voice-agent Python container using LiveKit Agents SDK. The agent is a participant in the LiveKit room that receives audio tracks, routes to STT (Deepgram or similar), feeds transcript to Claude via the Anthropic SDK, routes response to TTS (ElevenLabs or similar), and publishes audio back to the room.

Control plane: Banter API exposes an internal endpoint for the voice agent to register a session with (user_id, org_id, channel_id, call_id). Agent replies stream back as assistant messages in the call chat sidebar for fallback text display.

### STT transcription

For synchronous (live) transcription, the LiveKit Agents SDK pipeline above doubles as transcription: STT output gets saved to `banter_call_transcripts` with `speaker_user_id`, `utterance_start_ms`, `text`, `confidence`. For post-call transcription (calls without AI agent), add a BullMQ job that processes recorded audio via Whisper or similar after LiveKit egress.

### Rich embeds

When a message body contains a recognized link (Bam task URL, Beacon article URL, Bond deal URL), enrich `metadata` with the embed shape at post time. Frontend `message-item.tsx` renders embeds via a switch on `metadata.embed_type`. Server-side rendering done in `apps/banter-api/src/services/message.service.ts` postMessage pipeline.

### UI alignment

Follow `docs/banter-ui-alignment-plan.md`. Move org switcher, notifications bell, search input, and user avatar menu into `banter-layout.tsx` header. Remove the bottom user-info panel from sidebar. Adjust sidebar width to 240px to match BBB. Add Banter logo mark to the top-left.

### Message partitioning

Create explicit migration `0047_banter_messages_partition.sql` (or next free number) that:
1. Creates partitioned parent `banter_messages` by range on `created_at`.
2. Creates monthly partitions for the current year.
3. Adds a worker job to create next month's partition nightly.

## Dependencies

### Inbound

- Bolt subscribes to banter events.
- MCP tools expose 52 Banter operations.
- Beacon references (future).
- Bam task update notifications in channels (future).

### Outbound

- LiveKit SFU (port 7880 signaling) for voice/video infrastructure.
- Python voice-agent sidecar (port 4003, future).
- MinIO for attachments and call recording.
- PostgreSQL (shared with other apps).
- Redis for PubSub, rate limiting, session store.

## Open questions

1. **STT provider:** Deepgram, Whisper, AssemblyAI, or self-hosted? Cost vs latency tradeoff.
2. **TTS provider:** ElevenLabs, OpenAI TTS, or similar? Voice persona selection.
3. **LLM for voice agent:** Claude Opus 4.6 (current project standard) or a smaller/faster model for voice latency?
4. **Recording egress:** Where to store recordings (MinIO vs S3), retention policy, access control.
5. **Message partitioning rollout:** Can existing messages be migrated to partitioned table, or is this a fresh-only partition strategy?
6. **Presence idle threshold:** What defines "idle"? 5 minutes? 15 minutes? User-configurable?
7. **Voice agent invocation:** How does a user summon the agent in a call? Magic keyword, UI button, always-on listening?
