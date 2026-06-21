# Banter — Team Messaging & Collaboration

## Design Document v1.0

**Author:** Big Blue Ceiling Prototyping & Fabrication, LLC
**Date:** April 3, 2026
**Status:** Draft — Awaiting Approval

---

## 1. Executive Summary

Banter is a real-time team messaging and communication platform built natively into the BigBlueBam suite. It combines text messaging, threaded conversations, voice calling, video calling, and lightweight audio huddles into a single application — all deeply integrated with BigBlueBam (the project planning tool) and BigBlueBam Helpdesk (the customer ticketing portal).

Unlike standalone chat tools that require bridges and webhooks to connect with project management, Banter shares authentication, database infrastructure, and deep cross-linking with the rest of the suite. Unlike standalone meeting tools that exist as separate products, Banter's voice and video capabilities are built into the same channels where text conversations happen — start a huddle in `#backend-standup` and the transcript flows right into the channel.

Banter is **designed for human-AI collaboration from the start.** Every feature accessible to a human through the browser UI is equally accessible to an AI agent through MCP tools. AI agents can post messages, read channels, respond in threads, share task updates, join voice calls as spoken participants (via speech-to-text and text-to-speech integration), and participate in conversations as first-class team members. When voice services are not configured, AI agents gracefully degrade to text-only participation in calls — humans type to them, agents respond in text — ensuring that AI collaboration works at every deployment tier.

Banter targets the same audience as BigBlueBam: the engineering team. It shares BigBlueBam's user accounts, session infrastructure, and organization model. Helpdesk users (external customers) do **not** have access to Banter.

---

## 2. Key Principles

1. **Shared identity.** Banter uses BigBlueBam's existing users, organizations, sessions, and API keys. No separate registration. If you can log into BigBlueBam, you can use Banter.
2. **AI-native.** Every action — posting a message, creating a channel, uploading a file, reacting to a post, joining a voice call — has a corresponding MCP tool. AI agents are first-class participants, not afterthoughts. AI agents can speak in voice calls when voice services are configured, and fall back to text when they are not.
3. **Deeply integrated.** Tasks, tickets, sprints, and other BigBlueBam entities can be shared into Banter channels with rich, interactive previews and bidirectional links. Banter is not a silo.
4. **Real-time by default.** Messages, reactions, presence, typing indicators, voice, and video propagate instantly. The same Redis PubSub backbone used by BigBlueBam powers Banter's text layer; a dedicated SFU (Selective Forwarding Unit) handles media.
5. **Channels are configurable, not prescribed.** Admins control channel creation, visibility, membership, and permissions. Channels can be open (anyone in the org can join), private (invite-only), or restricted to specific user groups.
6. **Threaded conversations.** Every message can spawn a thread. Threads keep discussions focused without cluttering the main channel timeline.
7. **Voice is part of the channel.** Voice calls and huddles are not separate meetings — they happen inside channels. A huddle in `#backend-standup` is visible to everyone in that channel. Transcripts, recordings, and summaries flow into the channel as messages. Joining a huddle is one click, not a calendar invite.
8. **Progressive capability.** The platform works fully at every deployment tier. Text messaging works with zero external dependencies. Voice/video works with a self-hosted media server. AI voice participation works when STT/TTS services are configured. Each layer adds capability without breaking the layer below.

---

## 3. Core Concepts & Glossary

| Term | Definition |
|---|---|
| **Channel** | A named conversation stream within an organization. Analogous to a Slack channel. Has a topic, description, and membership list. Channels support text messaging, threaded replies, and optionally voice/video calls and huddles. |
| **Direct Message (DM)** | A private conversation between two users. Implemented as a special-case channel with exactly two members and `type = 'dm'`. Supports text and 1:1 voice/video calls. |
| **Group DM** | A private conversation between 3–8 users. Implemented as a channel with `type = 'group_dm'`. |
| **Message** | A single post in a channel. Contains styled or unstyled text, optional embedded images, optional file attachments, and optional BigBlueBam entity references. |
| **Thread** | A nested conversation attached to a parent message. Thread replies do not appear in the main channel timeline unless explicitly "sent to channel." |
| **Reaction** | An emoji response attached to a message. Lightweight acknowledgment without adding noise. |
| **Mention** | An `@user`, `@channel`, or `@here` reference within a message. Triggers a notification for the mentioned user(s). |
| **Pin** | A message marked as important, surfaced in a channel's pinned-messages panel. |
| **Bookmark** | A user-level saved reference to a specific message for later retrieval. |
| **Channel Group** | An admin-defined organizational category for channels (e.g., "Engineering", "Design", "Ops"). Displayed as collapsible sections in the sidebar. |
| **User Group** | A named set of users that can be mentioned collectively (e.g., `@backend-team`). Also used for bulk channel permission grants. |
| **Bot** | An automated participant (typically an AI agent) that authenticates via API key and interacts through MCP tools or the REST API. Displayed with a "BOT" badge. Bots can participate in voice calls as spoken participants when voice services are configured, or as text participants when they are not. |
| **Presence** | A user's current online status: `online`, `idle`, `dnd` (Do Not Disturb), `in_call`, or `offline`. |
| **Unread Marker** | Per-user, per-channel cursor tracking the last-read message. Drives unread counts and the "jump to new" indicator. |
| **Call** | A voice or video session within a channel or DM. Supports 1:1 and group configurations. Participants connect via WebRTC through the SFU. Calls have a defined start/end lifecycle and are logged in call history. |
| **Huddle** | A lightweight, persistent audio room attached to a channel. Unlike a call, a huddle stays "open" — participants drop in and out freely without formally starting or ending the session. Designed for ambient, low-ceremony voice communication (like being in the same room). Huddles appear as an always-available "join" button in the channel header. |
| **SFU (Selective Forwarding Unit)** | A media server (LiveKit) that receives each participant's audio/video stream and selectively forwards it to other participants. Unlike peer-to-peer, the SFU scales to many participants because each client maintains only one upstream connection. |
| **Voice Agent** | A server-side service that enables AI agents to participate in voice calls and huddles as spoken participants. It joins the SFU as a media peer, transcribes incoming audio via STT, sends transcripts to an LLM with MCP tools, and speaks the LLM's response via TTS. When voice services are not configured, AI agents participate in calls via a text sidebar instead. |
| **STT (Speech-to-Text)** | A service that converts audio streams into text transcripts. Used by the voice agent pipeline and optionally for live call transcription. Configurable: self-hosted (Whisper) or cloud (Deepgram, Google, OpenAI). |
| **TTS (Text-to-Speech)** | A service that converts text into spoken audio. Used by the voice agent to speak in calls. Configurable: self-hosted (Piper) or cloud (ElevenLabs, Google, OpenAI). |

---

## 4. Architecture

### 4.1 System Context

Banter runs as multiple new application containers alongside the existing BigBlueBam stack. The core containers are `banter-api` (REST + WebSocket) and `banter` (frontend SPA). For voice and video, `livekit` (SFU media server) and `voice-agent` (AI voice participation) are added. All share the same PostgreSQL database, Redis instance, MinIO object storage, and BullMQ worker infrastructure.

```
┌──────────────────────────────────────────────────────────────────┐
│                    Browser / AI Client                            │
│                                                                   │
│  Text: REST + WebSocket    Voice/Video: WebRTC    MCP: SSE/HTTP  │
└───────┬───────────────────────┬───────────────────────┬──────────┘
        │                       │                       │
┌───────▼───────────────────────│───────────────────────▼──────────┐
│       frontend (nginx :80)    │                                   │
│                               │                                   │
│  /b3/*        → BBB SPA + API (:4000)                            │
│  /helpdesk/*  → Helpdesk SPA + API (:4001)                       │
│  /banter/*    → Banter SPA + API (:4002)                         │
│  /banter/ws   → Banter WebSocket (:4002)                         │
│  /files/*     → MinIO proxy                                      │
│  /mcp/*       → MCP server (:3001)                               │
└───────┬───────────────────────│───────────────────────┬──────────┘
        │                       │                       │
┌───────▼────────┐  ┌──────────▼──────────┐  ┌────────▼───────────┐
│ banter-api     │  │ livekit             │  │ mcp-server         │
│ Fastify :4002  │  │ LiveKit SFU :7880   │  │ MCP SDK :3001      │
│ REST + WS      │  │ WebRTC media server │  │ (gains Banter +    │
│                │  │ :7881 (TURN/TCP)    │  │  voice tools)      │
└──────┬─────────┘  └──────────┬──────────┘  └────────┬───────────┘
       │                       │                       │
┌──────▼───────────────────────▼───────────────────────▼───────────┐
│                    Internal Docker Network                        │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ api (:4000)  │  │ worker       │  │ voice-agent  │           │
│  │ (existing)   │  │ (existing)   │  │ Python/Node  │           │
│  └──────────────┘  └──────────────┘  │ LiveKit Agent│           │
│                                       │ STT → LLM   │           │
│                                       │   → TTS      │           │
│                                       └──────────────┘           │
├──────────────┬──────────────────┬────────────────────────────────┤
│ PostgreSQL   │  Redis           │  MinIO                         │
│ :5432        │  :6379           │  :9000                         │
│ (shared)     │  (shared)        │  (shared)                      │
└──────────────┴──────────────────┴────────────────────────────────┘
```

### 4.2 URL Routing (nginx)

| URL Pattern | Target | Description |
|---|---|---|
| `http://localhost/` | Redirects to `/helpdesk/` | Default landing |
| `http://localhost/b3/` | BigBlueBam SPA | Project management app |
| `http://localhost/b3/api/*` | BigBlueBam REST API (:4000) | BBB REST endpoints |
| `http://localhost/b3/ws` | BigBlueBam WebSocket (:4000) | BBB real-time events |
| `http://localhost/helpdesk/` | Helpdesk SPA | Customer portal |
| `http://localhost/helpdesk/api/*` | Helpdesk API (:4001) | Helpdesk REST endpoints |
| `http://localhost/banter/` | Banter SPA | Team messaging app |
| `http://localhost/banter/api/*` | Banter REST API (:4002) | Banter REST endpoints |
| `http://localhost/banter/ws` | Banter WebSocket (:4002) | Banter real-time events |
| `http://localhost/files/*` | MinIO proxy | Uploaded files (shared) |
| `http://localhost/mcp/*` | MCP server (:3001) | MCP tools (82 total) |

WebRTC media traffic between browsers and the LiveKit SFU does **not** flow through nginx — it connects directly to the LiveKit container's ports (7880 for WebSocket signaling, 7881 for TURN/TCP fallback, and a UDP port range for media). In production, a TURN server (built into LiveKit or external `coturn`) handles NAT traversal.

### 4.3 Client Architecture

| Layer | Technology | Rationale |
|---|---|---|
| **Framework** | React 19 | Shared with BigBlueBam; concurrent rendering, transitions API |
| **Animation** | Motion (v11+) | Message entrance animations, drawer transitions, typing indicators |
| **State (server)** | TanStack Query v5 | Message pagination, channel lists, optimistic reactions |
| **State (client)** | Zustand | Active channel, sidebar collapse, draft messages, call state, notification prefs |
| **Styling** | TailwindCSS v4 + Radix Colors | Consistent design tokens with BigBlueBam |
| **UI Primitives** | Radix UI | Accessible dialogs, dropdowns, tooltips, context menus |
| **Routing** | TanStack Router or React Router v7 | Channel URLs, thread deep-links |
| **Rich Text** | Tiptap (ProseMirror) | Message composition with mentions, formatting, inline code |
| **Forms** | React Hook Form + Zod | Channel creation, settings, modals |
| **Virtual Lists** | TanStack Virtual or react-virtuoso | Efficient rendering of long message histories |
| **Date/Time** | date-fns v3 | Relative timestamps, date separators |
| **Emoji** | emoji-mart | Emoji picker for reactions and message composition |
| **Voice/Video** | LiveKit Client SDK (`livekit-client`) | WebRTC connection to SFU, track management, room state |
| **Audio Visualization** | Web Audio API | Speaking indicators, audio level meters in call UI |

### 4.4 API Architecture

| Layer | Technology | Rationale |
|---|---|---|
| **Runtime** | Node.js 22 LTS | Shared with BigBlueBam |
| **Framework** | Fastify v5 | Consistent with BigBlueBam API patterns |
| **Validation** | Zod (shared via `@bigbluebam/shared`) | Single source of truth |
| **Auth** | Shared session + API key validation | Reuses BigBlueBam's auth infrastructure |
| **ORM** | Drizzle ORM | Type-safe, SQL-first, shared migration tooling |
| **Realtime** | Socket.IO or native WebSocket with Redis PubSub | Per-channel rooms, typing indicators, presence, call signaling |
| **Queue** | BullMQ (Redis-backed) | Notification delivery, mention processing, link preview generation, call transcription |
| **Search** | PostgreSQL full-text search (pg_trgm + tsvector) | Message search across channels |
| **File Processing** | Sharp (images), file-type (MIME detection) | Image thumbnails, file validation |
| **Media Server** | LiveKit (Go binary, Docker container) | SFU for voice/video routing; supports rooms, tracks, data channels, webhooks, egress (recording) |
| **Voice Agent** | LiveKit Agents SDK (Python) or custom Node.js service | AI voice call participation: STT → LLM → TTS pipeline |

### 4.5 Voice & Video Stack

The voice/video subsystem is architected as a layered capability stack. Each layer adds functionality without breaking layers below it, and each layer works with both self-hosted and cloud providers.

```
┌──────────────────────────────────────────────────────────┐
│  Layer 3: AI Voice Agent                                  │
│  AI agents speak and listen in calls                      │
│  Requires: Layer 2 + STT provider + TTS provider + LLM   │
├──────────────────────────────────────────────────────────┤
│  Layer 2: Live Transcription                              │
│  Real-time captions during calls, post-call transcripts   │
│  Requires: Layer 1 + STT provider                         │
├──────────────────────────────────────────────────────────┤
│  Layer 1: Voice & Video Calls                             │
│  Calls, huddles, screen sharing between humans            │
│  Requires: LiveKit SFU (self-hosted or cloud)             │
├──────────────────────────────────────────────────────────┤
│  Layer 0: Text Messaging                                  │
│  Channels, DMs, threads, reactions, mentions, files       │
│  Requires: No external dependencies beyond base stack     │
└──────────────────────────────────────────────────────────┘
```

**Provider configuration.** Each external service slot (SFU, STT, TTS) can be configured by the org admin to use either a self-hosted or cloud provider. The admin configures these in the Banter admin panel, and the backend routes requests to the configured provider.

| Service Slot | Self-Hosted Option | Cloud Options | Fallback if Unconfigured |
|---|---|---|---|
| **SFU (media server)** | LiveKit OSS (Docker container, included in compose stack) | LiveKit Cloud | Voice/video features disabled. Calls and huddles unavailable. Text messaging works fully. |
| **STT (speech-to-text)** | faster-whisper (GPU Docker container) | Deepgram, Google Cloud Speech, OpenAI Whisper API | Live transcription disabled. AI voice agents fall back to text participation in calls. Call recordings have no transcript. |
| **TTS (text-to-speech)** | Piper (ONNX, CPU Docker container) | ElevenLabs, Google Cloud TTS, OpenAI TTS | AI voice agents fall back to text participation. Agent responses appear as text in the call's chat sidebar instead of spoken audio. |
| **LLM (for voice agent)** | — | Anthropic Claude API (Claude Sonnet recommended for latency) | AI voice agents cannot participate in calls at all. Text-based MCP tools still work in channels. |

---

## 5. Data Model

### 5.1 Entity-Relationship Summary

```
Organization ──< Channel ──< Message ──< ThreadReply
                    │            │  ──< MessageReaction
                    │            │  ──< MessageAttachment
                    │            │  ──< MessageEmbed (BBB entity refs)
                    │            └──< Pin
                    │
                    ├──< ChannelMembership ──> User
                    ├──< ChannelBookmark (user-level)
                    └──< Call ──< CallParticipant ──> User
                              ──< CallTranscript

Organization ──< UserGroup ──< UserGroupMembership ──> User
Organization ──< ChannelGroup

User ──< UnreadCursor (per channel)
User ──< MessageBookmark
User ──< UserPresence
User ──< NotificationPreference (Banter-specific)
```

### 5.2 Core Tables

All tables live in the **same PostgreSQL database** as BigBlueBam and Helpdesk. Table names are prefixed with `banter_` to avoid collisions.

#### `banter_channels`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `org_id` | UUID | FK → organizations.id, NOT NULL | Scoped to organization |
| `name` | VARCHAR(80) | NOT NULL | Lowercase, no spaces. e.g., "backend-standup" |
| `display_name` | VARCHAR(100) | NULLABLE | Optional friendly name. If null, `name` is formatted. |
| `slug` | VARCHAR(80) | NOT NULL | URL-safe identifier, defaults to `name` |
| `type` | VARCHAR(20) | NOT NULL, DEFAULT 'public' | `public`, `private`, `dm`, `group_dm` |
| `topic` | VARCHAR(500) | NULLABLE | Channel topic displayed in header |
| `description` | TEXT | NULLABLE | Longer channel description / purpose |
| `icon` | VARCHAR(10) | NULLABLE | Emoji or icon identifier |
| `channel_group_id` | UUID | FK → banter_channel_groups.id, NULLABLE | Organizational grouping |
| `created_by` | UUID | FK → users.id, NOT NULL | |
| `is_archived` | BOOLEAN | DEFAULT false | Archived channels are read-only |
| `is_default` | BOOLEAN | DEFAULT false | Users auto-join default channels |
| `allow_bots` | BOOLEAN | DEFAULT true | Whether AI agents / bots can post |
| `allow_huddles` | BOOLEAN | DEFAULT true | Whether huddles can be started |
| `message_retention_days` | INT | NULLABLE | Override org default. null = org setting. 0 = forever. |
| `last_message_at` | TIMESTAMPTZ | NULLABLE | Denormalized for sidebar sort |
| `last_message_preview` | VARCHAR(200) | NULLABLE | Denormalized preview text |
| `message_count` | INT | DEFAULT 0 | Denormalized |
| `member_count` | INT | DEFAULT 0 | Denormalized |
| `active_huddle_id` | UUID | FK → banter_calls.id, NULLABLE | Currently active huddle (null = none). One huddle per channel. |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(org_id, slug)` — channel slugs unique within org.

**Indexes:** `(org_id, type, is_archived)`, `(org_id, last_message_at DESC)`

#### `banter_channel_groups`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `org_id` | UUID | FK → organizations.id, NOT NULL | |
| `name` | VARCHAR(100) | NOT NULL | Display name |
| `position` | INT | NOT NULL | Sort order in sidebar |
| `is_collapsed_default` | BOOLEAN | DEFAULT false | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(org_id, name)`

#### `banter_channel_memberships`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `channel_id` | UUID | FK → banter_channels.id ON DELETE CASCADE | |
| `user_id` | UUID | FK → users.id ON DELETE CASCADE | |
| `role` | VARCHAR(20) | DEFAULT 'member' | `owner`, `admin`, `member` |
| `notifications` | VARCHAR(20) | DEFAULT 'default' | `all`, `mentions`, `none`, `default` |
| `is_muted` | BOOLEAN | DEFAULT false | |
| `joined_at` | TIMESTAMPTZ | DEFAULT now() | |
| `last_read_message_id` | UUID | FK → banter_messages.id, NULLABLE | Unread cursor |
| `last_read_at` | TIMESTAMPTZ | NULLABLE | |

**Unique constraint:** `(channel_id, user_id)`

#### `banter_messages`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `channel_id` | UUID | FK → banter_channels.id ON DELETE CASCADE | |
| `author_id` | UUID | FK → users.id | |
| `thread_parent_id` | UUID | FK → banter_messages.id, NULLABLE | Non-null = thread reply |
| `content` | TEXT | NOT NULL | Rich text (HTML from Tiptap) |
| `content_plain` | TEXT | NOT NULL | Plaintext for search and notifications |
| `content_format` | VARCHAR(20) | DEFAULT 'html' | `html`, `markdown`, `plain` |
| `is_system` | BOOLEAN | DEFAULT false | System-generated messages |
| `is_bot` | BOOLEAN | DEFAULT false | Posted by bot via API key |
| `is_edited` | BOOLEAN | DEFAULT false | |
| `is_deleted` | BOOLEAN | DEFAULT false | Soft delete |
| `edited_at` | TIMESTAMPTZ | NULLABLE | |
| `deleted_at` | TIMESTAMPTZ | NULLABLE | |
| `deleted_by` | UUID | FK → users.id, NULLABLE | |
| `call_id` | UUID | FK → banter_calls.id, NULLABLE | Non-null = call event card |
| `reply_count` | INT | DEFAULT 0 | Denormalized thread reply count |
| `reply_user_ids` | UUID[] | DEFAULT '{}' | Denormalized (capped at 5) |
| `last_reply_at` | TIMESTAMPTZ | NULLABLE | |
| `reaction_counts` | JSONB | DEFAULT '{}' | `{ "👍": 3, "🎉": 1 }` |
| `attachment_count` | INT | DEFAULT 0 | |
| `has_link_preview` | BOOLEAN | DEFAULT false | |
| `metadata` | JSONB | DEFAULT '{}' | BBB entity refs, link previews, transcript refs |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Indexes:** `(channel_id, created_at)`, `(channel_id, thread_parent_id, created_at)`, `(author_id, created_at)`, GIN on `content_plain` tsvector, `(channel_id, id)`.

**Partitioned** by `created_at` (monthly range partitions).

#### `banter_message_attachments`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `message_id` | UUID | FK → banter_messages.id ON DELETE CASCADE | |
| `uploader_id` | UUID | FK → users.id | |
| `filename` | VARCHAR(255) | NOT NULL | |
| `content_type` | VARCHAR(100) | NOT NULL | MIME type |
| `size_bytes` | BIGINT | NOT NULL | |
| `storage_key` | TEXT | NOT NULL | MinIO/S3 object key |
| `thumbnail_key` | TEXT | NULLABLE | For images |
| `width` | INT | NULLABLE | Image width |
| `height` | INT | NULLABLE | Image height |
| `duration_seconds` | INT | NULLABLE | Audio/video duration |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `banter_message_reactions`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `message_id` | UUID | FK → banter_messages.id ON DELETE CASCADE | |
| `user_id` | UUID | FK → users.id ON DELETE CASCADE | |
| `emoji` | VARCHAR(50) | NOT NULL | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(message_id, user_id, emoji)`

#### `banter_pins`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `channel_id` | UUID | FK → banter_channels.id ON DELETE CASCADE | |
| `message_id` | UUID | FK → banter_messages.id ON DELETE CASCADE | |
| `pinned_by` | UUID | FK → users.id | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(channel_id, message_id)`

#### `banter_bookmarks`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `user_id` | UUID | FK → users.id ON DELETE CASCADE | |
| `message_id` | UUID | FK → banter_messages.id ON DELETE CASCADE | |
| `note` | VARCHAR(500) | NULLABLE | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(user_id, message_id)`

#### `banter_calls`

Represents a voice call, video call, or huddle session.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `channel_id` | UUID | FK → banter_channels.id ON DELETE CASCADE | |
| `started_by` | UUID | FK → users.id | |
| `type` | VARCHAR(20) | NOT NULL | `voice`, `video`, `huddle` |
| `status` | VARCHAR(20) | NOT NULL, DEFAULT 'ringing' | `ringing` (1:1 only), `active`, `ended` |
| `livekit_room_name` | VARCHAR(255) | NOT NULL | Format: `banter_{org_id}_{channel_id}_{call_id}` |
| `livekit_room_sid` | VARCHAR(255) | NULLABLE | LiveKit server-assigned SID |
| `title` | VARCHAR(255) | NULLABLE | Optional call title |
| `recording_enabled` | BOOLEAN | DEFAULT false | |
| `recording_storage_key` | TEXT | NULLABLE | MinIO key for recording |
| `transcription_enabled` | BOOLEAN | DEFAULT false | |
| `transcript_storage_key` | TEXT | NULLABLE | MinIO key for full transcript |
| `ai_agent_mode` | VARCHAR(20) | DEFAULT 'auto' | `auto` (voice if available, else text), `voice`, `text`, `disabled` |
| `peak_participant_count` | INT | DEFAULT 0 | High-water mark |
| `started_at` | TIMESTAMPTZ | DEFAULT now() | |
| `ended_at` | TIMESTAMPTZ | NULLABLE | |
| `duration_seconds` | INT | NULLABLE | Computed on end |

**Indexes:** `(channel_id, status)`, `(channel_id, started_at DESC)`, `(started_by, started_at DESC)`

**Constraint:** `UNIQUE(channel_id) WHERE type = 'huddle' AND status = 'active'` — one active huddle per channel.

#### `banter_call_participants`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `call_id` | UUID | FK → banter_calls.id ON DELETE CASCADE | |
| `user_id` | UUID | FK → users.id | |
| `role` | VARCHAR(20) | DEFAULT 'participant' | `initiator`, `participant`, `voice_agent` |
| `joined_at` | TIMESTAMPTZ | DEFAULT now() | |
| `left_at` | TIMESTAMPTZ | NULLABLE | null = still in call |
| `duration_seconds` | INT | NULLABLE | Computed on leave |
| `has_audio` | BOOLEAN | DEFAULT true | |
| `has_video` | BOOLEAN | DEFAULT false | |
| `has_screen_share` | BOOLEAN | DEFAULT false | |
| `is_bot` | BOOLEAN | DEFAULT false | |
| `participation_mode` | VARCHAR(20) | DEFAULT 'media' | `media` (audio/video via SFU), `text` (text-only sidebar) |

**Unique constraint:** `(call_id, user_id, joined_at)` — allows rejoin records.

**Index:** `(call_id, left_at NULLS FIRST)` — find current participants.

#### `banter_call_transcripts`

Individual transcript segments for searchability and speaker attribution.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `call_id` | UUID | FK → banter_calls.id ON DELETE CASCADE | |
| `speaker_id` | UUID | FK → users.id | |
| `content` | TEXT | NOT NULL | Transcribed text |
| `started_at` | TIMESTAMPTZ | NOT NULL | Utterance start |
| `ended_at` | TIMESTAMPTZ | NOT NULL | Utterance end |
| `confidence` | FLOAT | NULLABLE | STT confidence (0.0–1.0) |
| `is_final` | BOOLEAN | DEFAULT true | false = interim result |

**Indexes:** `(call_id, started_at)`, GIN on `content` tsvector.

#### `banter_user_groups`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `org_id` | UUID | FK → organizations.id, NOT NULL | |
| `name` | VARCHAR(80) | NOT NULL | |
| `handle` | VARCHAR(80) | NOT NULL | e.g., `@backend-team` |
| `description` | VARCHAR(500) | NULLABLE | |
| `created_by` | UUID | FK → users.id | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(org_id, handle)`

#### `banter_user_group_memberships`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `group_id` | UUID | FK → banter_user_groups.id ON DELETE CASCADE | |
| `user_id` | UUID | FK → users.id ON DELETE CASCADE | |
| `added_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(group_id, user_id)`

#### `banter_user_preferences`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `user_id` | UUID | FK → users.id ON DELETE CASCADE, UNIQUE | |
| `default_notification_level` | VARCHAR(20) | DEFAULT 'mentions' | |
| `sidebar_sort` | VARCHAR(20) | DEFAULT 'recent' | `recent`, `alpha`, `custom` |
| `sidebar_collapsed_groups` | UUID[] | DEFAULT '{}' | |
| `theme_override` | VARCHAR(20) | NULLABLE | |
| `enter_sends_message` | BOOLEAN | DEFAULT true | |
| `show_message_timestamps` | VARCHAR(20) | DEFAULT 'hover' | |
| `compact_mode` | BOOLEAN | DEFAULT false | |
| `auto_join_huddles` | BOOLEAN | DEFAULT false | Auto-connect audio when huddle starts |
| `noise_suppression` | BOOLEAN | DEFAULT true | Browser-side noise suppression |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `banter_settings`

Global Banter configuration per organization.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `org_id` | UUID | FK → organizations.id, UNIQUE | |
| `default_channel_id` | UUID | FK → banter_channels.id, NULLABLE | |
| `allow_channel_creation` | VARCHAR(20) | DEFAULT 'members' | `admins_only`, `members`, `everyone` |
| `allow_dm` | BOOLEAN | DEFAULT true | |
| `allow_group_dm` | BOOLEAN | DEFAULT true | |
| `allow_guest_access` | BOOLEAN | DEFAULT false | |
| `message_retention_days` | INT | DEFAULT 0 | 0 = forever |
| `max_file_size_mb` | INT | DEFAULT 25 | |
| `allowed_file_types` | TEXT[] | DEFAULT '{}' | Empty = all |
| `custom_emoji` | JSONB | DEFAULT '[]' | |
| `enable_link_previews` | BOOLEAN | DEFAULT true | |
| `enable_bbb_integration` | BOOLEAN | DEFAULT true | |
| `voice_video_enabled` | BOOLEAN | DEFAULT false | Master switch. Controls whether call/huddle UI appears. |
| `livekit_host` | VARCHAR(500) | NULLABLE | LiveKit URL |
| `livekit_api_key` | VARCHAR(255) | NULLABLE | Encrypted at rest |
| `livekit_api_secret` | TEXT | NULLABLE | Encrypted at rest |
| `max_call_participants` | INT | DEFAULT 50 | |
| `max_call_duration_minutes` | INT | DEFAULT 480 | 0 = unlimited |
| `allow_recording` | BOOLEAN | DEFAULT false | |
| `recording_storage_prefix` | VARCHAR(255) | DEFAULT 'banter/recordings/' | |
| `transcription_enabled` | BOOLEAN | DEFAULT false | Requires STT provider |
| `stt_provider` | VARCHAR(50) | NULLABLE | `deepgram`, `google`, `openai`, `whisper_self_hosted` |
| `stt_provider_config` | JSONB | DEFAULT '{}' | API keys, endpoints. Encrypted at rest. |
| `tts_provider` | VARCHAR(50) | NULLABLE | `elevenlabs`, `google`, `openai`, `piper_self_hosted` |
| `tts_provider_config` | JSONB | DEFAULT '{}' | Encrypted at rest. |
| `tts_default_voice` | VARCHAR(100) | NULLABLE | Default voice ID |
| `ai_voice_agent_enabled` | BOOLEAN | DEFAULT false | Requires voice_video + STT + TTS + LLM |
| `ai_voice_agent_llm_provider` | VARCHAR(50) | DEFAULT 'anthropic' | |
| `ai_voice_agent_llm_config` | JSONB | DEFAULT '{}' | API key, model, temperature. Encrypted. |
| `ai_voice_agent_greeting` | VARCHAR(500) | NULLABLE | Greeting when AI joins a call |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

### 5.3 Relationship to BigBlueBam

Banter uses the existing `users`, `organizations`, `sessions`, and `api_keys` tables directly — no user duplication. `banter_messages.metadata` stores JSON references to BBB tasks, tickets, sprints, projects, and comments. `banter_calls` stores call lifecycle data with transcript segments searchable via full-text index.

---

## 6. Authentication & Authorization

### 6.1 Authentication

Banter uses **exactly the same authentication** as BigBlueBam: shared session cookies (Redis-backed, 30-day sliding expiry), `bbam_` API keys, and OAuth2/OIDC. If a user is logged into BigBlueBam, they are logged into Banter.

For **LiveKit room tokens**, the `banter-api` generates short-lived JWTs (signed with LiveKit API secret) when a user joins a call. Tokens encode participant identity, room name, and permissions (publish audio, video, screen share). Tokens are minted on demand and never stored.

### 6.2 Authorization (RBAC)

#### Organization-Level Roles (inherited from BigBlueBam)

| Org Role | Banter Capabilities |
|---|---|
| **Owner** | Full Banter admin. Manage voice/video settings, STT/TTS provider config. |
| **Admin** | Create/archive/delete any channel. Manage user groups. Moderate any message. Enable/disable recording. |
| **Member** | Create channels (if permitted). Join public channels. Post messages. React. Start/join calls and huddles. |

#### Channel-Level Permission Matrix

| Action | Channel Owner | Channel Admin | Member |
|---|---|---|---|
| View messages | Yes | Yes | Yes |
| Post message | Yes | Yes | Yes |
| Edit own message | Yes | Yes | Yes |
| Delete own message | Yes | Yes | Yes |
| Edit any message | Yes | No | No |
| Delete any message | Yes | Yes | No |
| Pin/unpin messages | Yes | Yes | No |
| Edit channel settings | Yes | Yes | No |
| Add/remove members | Yes | Yes | No |
| Archive channel | Yes | No | No |
| Delete channel | Yes (+ org admin) | No | No |
| Start a call | Yes | Yes | Yes |
| Start/end a huddle | Yes | Yes | Yes (start) / No (end for all) |
| Enable recording | Yes | Yes | No |
| Invite AI agent to call | Yes | Yes | Yes |
| Upload files | Yes | Yes | Yes |

---

## 7. Banter API (REST)

All endpoints under `/banter/api/v1/`. Same conventions as BigBlueBam: JSON, cursor-based pagination, filter/sort query params, standard error responses.

### 7.1 Channel Endpoints

| Method | Endpoint | Description | Scope |
|---|---|---|---|
| `GET` | `/v1/channels` | List user's channels with unread counts | read |
| `POST` | `/v1/channels` | Create channel | read_write |
| `GET` | `/v1/channels/browse` | Browse all public channels | read |
| `GET` | `/v1/channels/:id` | Channel detail | read |
| `PATCH` | `/v1/channels/:id` | Update settings (admin+) | read_write |
| `DELETE` | `/v1/channels/:id` | Delete channel (org admin / owner) | admin |
| `POST` | `/v1/channels/:id/join` | Join public channel | read_write |
| `POST` | `/v1/channels/:id/leave` | Leave channel | read_write |
| `GET` | `/v1/channels/:id/members` | List members | read |
| `POST` | `/v1/channels/:id/members` | Add members | read_write |
| `PATCH` | `/v1/channels/:id/members/:user_id` | Update member role | read_write |
| `DELETE` | `/v1/channels/:id/members/:user_id` | Remove member | read_write |
| `POST` | `/v1/dm` | Create/retrieve DM | read_write |
| `POST` | `/v1/group-dm` | Create group DM | read_write |
| `GET` | `/v1/dm` | List DMs/group DMs | read |

### 7.2 Message Endpoints

| Method | Endpoint | Description | Scope |
|---|---|---|---|
| `GET` | `/v1/channels/:id/messages` | List messages (cursor: `?before=`, `?after=`, `?around=`) | read |
| `POST` | `/v1/channels/:id/messages` | Post message | read_write |
| `GET` | `/v1/messages/:id` | Get message with thread summary | read |
| `PATCH` | `/v1/messages/:id` | Edit message | read_write |
| `DELETE` | `/v1/messages/:id` | Soft-delete | read_write |
| `GET` | `/v1/messages/:id/thread` | List thread replies | read |
| `POST` | `/v1/messages/:id/thread` | Post thread reply (with `also_send_to_channel?`) | read_write |
| `POST` | `/v1/messages/:id/reactions` | Add/toggle reaction | read_write |
| `GET` | `/v1/messages/:id/reactions` | List reactions | read |
| `GET` | `/v1/channels/:id/pins` | List pins | read |
| `POST` | `/v1/channels/:id/pins` | Pin message | read_write |
| `DELETE` | `/v1/channels/:id/pins/:message_id` | Unpin | read_write |
| `GET` | `/v1/bookmarks` | List user's bookmarks | read |
| `POST` | `/v1/bookmarks` | Bookmark message | read_write |
| `DELETE` | `/v1/bookmarks/:id` | Remove bookmark | read_write |

### 7.3 Call & Huddle Endpoints

| Method | Endpoint | Description | Scope |
|---|---|---|---|
| `POST` | `/v1/channels/:id/calls` | Start call/huddle. Body: `{ type, title?, recording_enabled?, transcription_enabled?, ai_agent_mode? }`. Returns call + LiveKit token. For huddles, returns existing if active. | read_write |
| `GET` | `/v1/channels/:id/calls` | Call history for channel | read |
| `GET` | `/v1/calls/:id` | Call detail (participants, duration, recording URL, transcript URL) | read |
| `POST` | `/v1/calls/:id/join` | Join active call/huddle. Returns LiveKit token. | read_write |
| `POST` | `/v1/calls/:id/leave` | Leave call. Auto-ends non-huddle calls if last human leaves. | read_write |
| `POST` | `/v1/calls/:id/end` | End call for all (admin+ for huddles, any participant for calls) | read_write |
| `POST` | `/v1/calls/:id/invite-agent` | Invite AI agent. Body: `{ agent_user_id?, mode?: 'auto'|'voice'|'text' }` | read_write |
| `POST` | `/v1/calls/:id/remove-agent` | Remove AI agent from call | read_write |
| `GET` | `/v1/calls/:id/participants` | List current and past participants | read |
| `GET` | `/v1/calls/:id/transcript` | Get call transcript (live or post-call) | read |
| `PATCH` | `/v1/calls/:id` | Update settings mid-call (toggle recording/transcription, admin+) | read_write |

**LiveKit token flow:** Client calls start/join → banter-api validates permissions, creates/retrieves call record, generates LiveKit JWT (signed with API secret, encodes user ID, room name, track grants) → token returned to client → client connects to LiveKit SFU directly via WebRTC.

### 7.4 Search Endpoints

| Method | Endpoint | Description | Scope |
|---|---|---|---|
| `GET` | `/v1/search/messages` | Full-text search. `?q=&channel_id=&author_id=&before=&after=&has_attachments=` | read |
| `GET` | `/v1/search/channels` | Search by name/topic | read |
| `GET` | `/v1/search/transcripts` | Search call transcripts. `?q=&channel_id=&speaker_id=&before=&after=` | read |

### 7.5 Other Endpoints

| Method | Endpoint | Description | Scope |
|---|---|---|---|
| `POST` | `/v1/files/upload` | Upload file (multipart/form-data) | read_write |
| `POST` | `/v1/files/presigned-upload` | Get presigned upload URL | read_write |
| `GET` | `/v1/user-groups` | List org user groups | read |
| `POST` | `/v1/user-groups` | Create group (org admin) | admin |
| `PATCH` | `/v1/user-groups/:id` | Update group | admin |
| `DELETE` | `/v1/user-groups/:id` | Delete group | admin |
| `POST` | `/v1/user-groups/:id/members` | Add members | admin |
| `DELETE` | `/v1/user-groups/:id/members/:user_id` | Remove member | admin |
| `GET` | `/v1/me/preferences` | Get Banter preferences | read |
| `PATCH` | `/v1/me/preferences` | Update preferences | read_write |
| `POST` | `/v1/me/presence` | Set presence status | read_write |
| `GET` | `/v1/me/unread` | Unread summary | read |
| `POST` | `/v1/channels/:id/mark-read` | Mark channel as read | read_write |

### 7.6 Admin Endpoints

| Method | Endpoint | Description | Scope |
|---|---|---|---|
| `GET` | `/v1/admin/settings` | Get full settings (including voice/video/STT/TTS config) | admin |
| `PATCH` | `/v1/admin/settings` | Update settings | admin |
| `POST` | `/v1/admin/settings/test-stt` | Test STT provider (send sample audio, get transcript) | admin |
| `POST` | `/v1/admin/settings/test-tts` | Test TTS provider (send text, get audio URL) | admin |
| `POST` | `/v1/admin/settings/test-livekit` | Test LiveKit connection | admin |
| `GET/POST/PATCH/DELETE` | `/v1/admin/channel-groups[/:id]` | Channel group CRUD | admin |
| `POST` | `/v1/admin/channel-groups/reorder` | Reorder groups | admin |

---

## 8. WebSocket Protocol (Real-Time)

### 8.1 Connection & Rooms

Connect at `ws://localhost/banter/ws?token=<session>` or `?api_key=bbam_...`. On connect, server subscribes to user's rooms and sends initial unread + active calls.

| Room Pattern | Events |
|---|---|
| `banter:channel:{id}` | `message.*`, `reaction.*`, `typing.*`, `pin.*`, `call.started`, `call.ended`, `huddle.*`, `member.*`, `channel.updated` |
| `banter:user:{id}` | `notification`, `unread.update`, `channel.joined/left`, `presence.changed`, `call.incoming` |
| `banter:org:{id}` | `channel.created/archived/deleted`, `user_group.updated` |
| `banter:call:{id}` | `call.participant_joined/left`, `call.transcript_segment`, `call.agent_text_message`, `call.recording_*`, `call.ended` |

### 8.2 Key Events

**Text events:** `message.created/updated/deleted`, `reaction.added/removed`, `typing.start/stop`, `pin.added/removed`, `thread.reply`, `member.joined/left`, `channel.updated`.

**Call events:** `call.started` (channel room), `call.ended` (channel + call rooms), `call.incoming` (user room, 1:1 only), `call.participant_joined/left`, `call.recording_started/stopped`, `call.transcript_segment` (speaker-attributed live transcript), `call.agent_text_message` (AI in text mode), `huddle.active/empty`.

**User/org events:** `notification`, `unread.update`, `channel.joined/left`, `presence.changed`, `channel.created/archived`, `user_group.updated`.

### 8.3 Typing & Presence

Typing: client heartbeat every 3s, server broadcasts excluding sender, expires after 5s. Redis key with TTL.

Presence statuses: `online`, `idle` (5min inactive), `in_call` (active call participant — includes channel name), `dnd` (manual), `offline` (no connections, 30s grace). Stored in Redis with TTL.

---

## 9. Banter Portal (Frontend)

### 9.1 Layout & Pages

Standard three-panel layout: sidebar (channels, DMs), main content (message timeline), and right panel (threads, call panel). Routes: `/banter/channels/:slug`, `/banter/channels/:slug/thread/:message_id`, `/banter/channels/:slug/call/:call_id`, `/banter/dm/:user_id`, `/banter/search`, `/banter/bookmarks`, `/banter/browse`, `/banter/settings`, `/banter/admin`.

### 9.2 Message Timeline

Virtual-scrolled (TanStack Virtual / react-virtuoso) message list with date separators, message grouping (same author within 5 minutes), unread marker, jump-to-bottom button, auto-load older messages on scroll up, and Motion spring entrance animations.

### 9.3 Message Rendering

Each message: author avatar (36px circle), display name (bold, "BOT" badge for bots), timestamp (relative/absolute), rich text content (Tiptap HTML: bold, italic, strikethrough, code, code blocks with syntax highlighting, blockquotes, lists, links, embedded images, @mentions, #channels, task refs like `BBB-142` as interactive chips), attachments (image thumbnails + lightbox, file download cards), BBB entity embed cards, reaction row, thread indicator ("💬 N replies"), edited indicator.

### 9.4 Compose Box

Tiptap editor with: formatting toolbar (B/I/strikethrough/code/codeblock/blockquote/lists/link), file upload (paperclip/drag-drop/clipboard paste, presigned URL upload to MinIO), emoji picker (emoji-mart, `:shortcode:` inline), @mention autocomplete (users, groups, @channel, @here), #channel autocomplete, task reference autocomplete (BBB-142 → chip with hover tooltip), image embedding. Enter sends (configurable). Drafts persisted in Zustand/localStorage per channel.

### 9.5 Thread View

Right-side panel (400px, full-screen on mobile). Parent message at top, chronological replies below, compose box with "Also send to #channel" checkbox. Auto-follow on reply.

### 9.6 Channel Browser

Grid/list of public channels the user hasn't joined. Shows name, topic, member count, last active. Search/filter. "Join" button.

### 9.7 Search

Global full-text search across messages + transcripts. Filters: channel, author, date range, has attachments, has reactions. Click result jumps to message in context.

### 9.8 Call & Huddle UI

**Channel header:** When `voice_video_enabled`, shows [📞 Call] and [🎤 Huddle] buttons. Active huddle shows persistent banner below header with participant avatars and "Join" button.

**Incoming call overlay (1:1):** Full-screen caller avatar + Accept/Decline. 30s timeout → missed call system message.

**Voice call/huddle panel:** Inline at top of channel (doesn't replace timeline). Shows participant circles with speaking indicators (Web Audio API levels), mute/camera/screenshare/invite-agent/record/transcript/leave controls. Live transcript scroll area when transcription enabled.

**Video call:** Expanded view replacing timeline. Grid layout (2–9 participants), speaker view (10+). AI agents without video show avatar + audio waveform. Screen share replaces main grid.

**AI agent text sidebar:** When agent is in text mode, a chat sidebar appears within the call UI. Visible only to participants. Text input for typing to the agent. Agent responds in text. Ephemeral during call, optionally posted as summary to channel on call end.

### 9.9 Call Event Messages

System messages in channel: "📞 Alice started a voice call", "🎤 Alice started a huddle", "📞 Voice call ended · 12m · 3 participants" (with transcript link if available), "📞 Missed call from Alice", "🤖 BBB Bot joined the huddle (voice/text)".

### 9.10 Admin Settings — Voice & Video Panel

"Voice & Video" section in admin: master toggle, LiveKit config (host/key/secret + test), call limits, recording toggle, transcription toggle + STT provider dropdown + config + test, AI voice agent toggle + TTS provider dropdown + config + test + LLM config + greeting, status indicators (green/red badges per service).

---

## 10. Notifications

### 10.1 Triggers

Text: new message (unread count), @mention (badge + email), @channel/@here (badge), DM (badge + email), thread reply (badge + configurable email), pin (system message), channel add/remove (badge + email).

Calls: incoming 1:1 call (full-screen overlay), huddle started (banner), AI agent mention (badge).

### 10.2 Preference Hierarchy

User default → per-channel override → mute override → DND override → in-call deferral.

### 10.3 Email

BullMQ worker, job type `banter-email`. Templates: `banter-mention`, `banter-dm`, `banter-thread-reply`, `banter-channel-invite`. Rate limited: max one email per 5 minutes per user (batched digest).

---

## 11. BigBlueBam Integration

### 11.1 Cross-App Navigation

Top nav: `[📋 BBB] [💬 Banter] [🎧 Helpdesk]`. Banter shows unread mention badge.

### 11.2 Sharing

"Share to Banter" button in BBB task detail. Modal: channel picker + optional message. Creates message with `metadata.bbb_entities`. Shareable: Task, Sprint, Sprint Report, Comment, Ticket, Project. Rich embed cards with "Open in BigBlueBam →" link.

### 11.3 Task References

`BBB-142` → resolved via BBB API → colored chip with hover tooltip. Unresolved = plain text.

### 11.4 Activity Feed

Configurable per-project feed channel. Events: task created/completed, sprint started/completed, ticket created, PR linked. Posted by system bot with `is_system = true, is_bot = true`.

### 11.5 Backlinks

BBB task detail shows "Banter" section: recent messages referencing this task, count, quick search link.

---

## 12. MCP Server Integration

### 12.1 New Tools (44 total)

**Channel tools (10):** `banter_list_channels`, `banter_get_channel`, `banter_create_channel`, `banter_update_channel`, `banter_archive_channel` (confirm), `banter_delete_channel` (confirm), `banter_join_channel`, `banter_leave_channel`, `banter_add_channel_members`, `banter_remove_channel_member`.

**Message tools (8):** `banter_list_messages`, `banter_get_message`, `banter_post_message`, `banter_edit_message`, `banter_delete_message` (confirm), `banter_react`, `banter_pin_message`, `banter_unpin_message`.

**Thread tools (2):** `banter_list_thread_replies`, `banter_reply_to_thread`.

**Search tools (3):** `banter_search_messages`, `banter_browse_channels`, `banter_search_transcripts`.

**DM tools (2):** `banter_send_dm`, `banter_send_group_dm`.

**User group tools (5):** `banter_list_user_groups`, `banter_create_user_group`, `banter_update_user_group`, `banter_add_group_members`, `banter_remove_group_member`.

**Call & huddle tools (10):** `banter_start_call`, `banter_join_call`, `banter_leave_call`, `banter_end_call` (confirm), `banter_get_call`, `banter_list_calls`, `banter_get_transcript`, `banter_invite_agent_to_call`, `banter_post_call_text`, `banter_get_active_huddle`.

**Integration & utility tools (4):** `banter_share_task`, `banter_share_sprint`, `banter_share_ticket`, `banter_get_unread`.

**Grand total: 38 existing BBB tools + 44 new Banter tools = 82 tools.**

### 12.2 New Resources (8)

`banter://channels`, `banter://channels/{slug}`, `banter://channels/{slug}/thread/{message_id}`, `banter://dm/{user_id}`, `banter://me/unread`, `banter://search?q={query}`, `banter://calls/{id}`, `banter://channels/{slug}/huddle`.

### 12.3 New Prompts (4)

`banter_channel_summary` (recent activity summary), `banter_standup_broadcast` (run BBB standup + post to channel), `banter_thread_summary` (summarize long thread), `banter_call_recap` (summarize call transcript → decisions, action items, open questions → post to channel).

### 12.4 AI Agent Voice via MCP

When `banter_join_call` is called with voice mode: banter-api validates config (ai_voice_agent_enabled + STT + TTS + LLM) → sends spawn request to voice-agent service → voice-agent connects to LiveKit room → audio pipeline activates (STT → LLM + MCP tools → TTS → audio track). Falls back to text mode if voice services unavailable.

---

## 13. Voice Agent Architecture

### 13.1 Service Overview

The `voice-agent` container bridges STT, LLM, and TTS into a real-time audio pipeline connected to the LiveKit SFU.

```
┌──────────────────────────────────────────────────────────────────┐
│                    voice-agent Container                          │
│                                                                   │
│  ┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌────────┐ │
│  │ LiveKit  │    │              │    │          │    │LiveKit │ │
│  │ Room     │───▶│  STT Engine  │───▶│  LLM     │───▶│ Room   │ │
│  │ (audio   │    │  (Deepgram/  │    │  (Claude │    │(audio  │ │
│  │  input)  │    │   Whisper)   │    │  + MCP   │    │ output)│ │
│  └──────────┘    │              │    │  tools)  │    └────────┘ │
│                   └──────────────┘    │          │               │
│                                       │    │     │               │
│                         ┌─────────────┘    │     │               │
│                         │  TTS Engine      │     │               │
│                         │  (ElevenLabs/    │◀────┘               │
│                         │   Piper)         │                     │
│                         └──────────────────┘                     │
│                                                                   │
│  Control plane: HTTP API on :4003 (internal only)                │
│  POST /agents/spawn | POST /agents/:id/despawn | GET /agents     │
└──────────────────────────────────────────────────────────────────┘
```

### 13.2 Pipeline Detail

1. **Audio ingestion:** Subscribe to all audio tracks in LiveKit room (mixed, excluding own track).
2. **STT:** Stream to configured provider. Deepgram (~300ms), Google (~500ms), OpenAI Whisper (~1-2s), self-hosted faster-whisper (GPU dependent).
3. **Turn detection:** VAD-based endpointing. 700ms silence threshold (configurable). Agent waits for speaker to finish.
4. **LLM reasoning:** Finalized transcript sent to Claude with conversation history + all 82 MCP tools. System prompt instructs concise voice responses (1–3 sentences).
5. **TTS:** LLM text response streamed to provider. ElevenLabs (~400ms TTFB), Google (~500ms), OpenAI (~700ms), Piper (~200ms self-hosted).
6. **Audio output:** Synthesized audio published as agent's track in LiveKit room.

**Latency budget (target: < 2s end-to-end):**

| Stage | Cloud path (Deepgram + ElevenLabs) | Self-hosted (whisper + Piper) |
|---|---|---|
| STT | ~300ms | ~500ms (GPU) |
| Endpointing | ~700ms | ~700ms |
| LLM first token | ~500ms | ~500ms |
| TTS TTFB | ~400ms | ~200ms |
| **Total** | **~1.9s** | **~1.9s** |

**Filler response pattern:** Immediately generate acknowledgment ("Let me check...") via TTS while LLM processes tool calls. Stream full response once tools return.

### 13.3 Graceful Degradation

| Config State | Behavior |
|---|---|
| `voice_video_enabled = false` | No calls/huddles. Text only. AI agents interact via channels. |
| Voice enabled, no STT/TTS | Calls work for humans. AI agents join in text mode (type ↔ text sidebar). |
| Voice + STT, no TTS | AI listens (transcript → LLM). Responds as text messages in call sidebar. |
| Voice + STT + TTS + LLM | Full voice participation. AI speaks and listens. |

### 13.4 LiveKit Webhooks

LiveKit sends room events to `POST /banter/api/v1/webhooks/livekit`:

| Event | Action |
|---|---|
| `room_started` | Update `livekit_room_sid` |
| `participant_joined` | Insert participant record. Broadcast event. Update `peak_participant_count`. |
| `participant_left` | Set `left_at`. Broadcast. Auto-end non-huddle call if last human left. |
| `room_finished` | Set status=ended, compute duration. Clear `active_huddle_id`. Post system message. |
| `track_published` | Update participant's `has_audio/has_video/has_screen_share`. |
| `egress_ended` | Store recording reference. |

---

## 14. Security Considerations

- **Channel isolation:** Users can only access channels they're members of. Private channels and DMs invisible to non-members at API level.
- **Org isolation:** All queries scoped to `org_id`. Cross-org access impossible.
- **Bot restrictions:** `allow_bots` per channel. `allow_huddles` per channel.
- **Media encryption:** All WebRTC streams encrypted (DTLS-SRTP). LiveKit enforces.
- **Token scoping:** LiveKit JWTs encode specific track permissions. Short-lived (24h max, typically call-duration).
- **Recording consent:** Red "Recording" indicator for all participants. System message posted. Can leave if don't consent.
- **Transcript privacy:** Encrypted at rest in MinIO. Channel membership governs access.
- **Voice agent isolation:** Internal Docker network only. STT/TTS keys encrypted in DB, passed at spawn time only.
- **AI agent audit:** All voice agent tool calls logged to `activity_log` with `mcp.voice_agent.*` prefix.
- **Input sanitization:** DOMPurify on server, restricted Markdown renderer for API/MCP posts.
- **File validation:** MIME check, size limit, filename sanitization.
- **Rate limiting:** Post 30/min (user), 120/min (bot), upload 10/min, search 20/min, reaction 60/min, channel create 5/hr, call start 5/hr, WebSocket 5 concurrent.
- **Data retention:** Message retention per org/channel. Recording retention (default 90 days). Nightly worker job. Attachment cleanup after 30-day grace.
- **Audit logging:** All admin actions to `activity_log` with `banter.*` prefixes.

---

## 15. Docker Setup

### 15.1 New Containers

**banter-api** — Fastify :4002. REST + WebSocket. Depends on postgres, redis. Env: DATABASE_URL, REDIS_URL, SESSION_SECRET, MINIO_*, BBB_API_INTERNAL_URL, VOICE_AGENT_URL, LIVEKIT_WEBHOOK_SECRET. 512MB RAM, 1.0 CPU.

**livekit** — LiveKit SFU. `livekit/livekit-server:latest`. Ports: 7880 (WS signaling), 7881 (TURN/TCP), 7882/udp (WebRTC). Config via `infra/livekit/livekit.yaml`. Webhook to banter-api. 512MB RAM, 1.0 CPU.

**voice-agent** — AI voice participation. Python or Node.js. Port: 4003 (internal). Env: LIVEKIT_URL, LIVEKIT_API_KEY/SECRET, REDIS_URL, MCP_SERVER_URL. STT/TTS/LLM config passed per-session from banter-api. 1GB RAM, 2.0 CPU.

**Optional** (`docker-compose.voice.yml`):

**faster-whisper** — Self-hosted STT. `fedirz/faster-whisper-server:latest`. Port: 8100. 2GB RAM, 2.0 CPU (GPU recommended).

**piper-tts** — Self-hosted TTS. `rhasspy/piper:latest`. Port: 8200. 512MB RAM, 1.0 CPU.

### 15.2 Resource Allocation

| Tier | Additional RAM | Additional CPU |
|---|---|---|
| Text only (banter-api) | +512 MB | +1.0 |
| + Voice/video (+ livekit) | +1 GB | +2.0 |
| + AI voice (+ voice-agent, cloud STT/TTS) | +2 GB | +4.0 |
| + Self-hosted STT/TTS | +4.5 GB | +7.0 (GPU recommended) |

### 15.3 nginx Configuration

Adds `/banter/` (SPA), `/banter/api/` (proxy to :4002), `/banter/ws` (WebSocket proxy with upgrade headers and 86400s timeouts).

---

## 16. Monorepo Structure

```
apps/
  banter-api/         Fastify REST + WebSocket (:4002)
    src/routes/         Channel, message, thread, reaction, pin, search,
                        bookmark, user-group, admin, file, dm,
                        call, huddle, webhook (LiveKit) routes
    src/services/       channel, message, thread, search, notification,
                        presence, integration, call, livekit-token,
                        voice-agent-client
    src/db/schema/      Drizzle definitions for banter_* tables
    src/ws/             WebSocket handlers
    Dockerfile

  banter/              React SPA
    src/components/
      channels/          ChannelList, ChannelHeader, ChannelBrowser, ChannelSettings
      messages/          MessageTimeline, MessageItem, MessageCompose, Reactions
      threads/           ThreadPanel, ThreadReplyList
      calls/             CallPanel, CallControls, ParticipantGrid, ParticipantTile,
                         IncomingCallOverlay, HuddleBanner, VideoGrid, ScreenShareView,
                         CallEventMessage, AgentTextSidebar, TranscriptView
      sidebar/           BanterSidebar, ChannelListItem, DMListItem
      common/            UserProfilePopover, EmojiPicker, MentionDropdown, TypingIndicator
      search/            SearchView, SearchFilters
      admin/             BanterAdminSettings, VoiceVideoSettings, STTProviderConfig,
                         TTSProviderConfig, LLMProviderConfig
    src/hooks/           useChannels, useMessages, useThreads, usePresence,
                         useTyping, useUnread, useCall, useHuddle, useLiveKit
    src/stores/          activeChannel, sidebar, drafts, callState
    Dockerfile

  voice-agent/         AI voice call participation (Python or Node.js)
    src/
      agent.py            Main agent: per-call pipeline manager
      stt/                Adapters: deepgram, google, openai, whisper (self-hosted)
      tts/                Adapters: elevenlabs, google, openai, piper (self-hosted)
      llm/                Claude API client with MCP tool integration
      pipeline.py         Orchestrator: STT → LLM → TTS
      api.py              HTTP control API (:4003)
    Dockerfile

  api/                 (existing) gains: Share to Banter, activity feed posting
  mcp-server/          (existing) gains: 44 new banter_* tools, 8 resources, 4 prompts
  frontend/            (existing) gains: Share to Banter button, Banter mentions, top nav tab
  worker/              (existing) gains: banter-email, banter-retention,
                       banter-link-preview, banter-activity-feed,
                       banter-transcript-finalize jobs

infra/
  livekit/             livekit.yaml
  piper/voices/        Self-hosted TTS voice models
```

---

## 17. Implementation Phases

### Phase 1 — Core Messaging (1–2 weeks)
Database tables (channels, memberships, messages, attachments, reactions, settings, preferences). Banter API (auth, channel CRUD, message CRUD, reactions, file upload). WebSocket (rooms, message events, typing, presence). Frontend (sidebar, channel view, message timeline, compose box, reactions, unread tracking). Docker: banter-api + nginx routing. Auto-create #general.

### Phase 2 — Threads & DMs (0.5–1 week)
Threads (replies, panel, follow, also-send-to-channel). DMs and group DMs. Presence (online/idle/dnd/offline). Typing indicators.

### Phase 3 — Voice & Video Calls (1–1.5 weeks)
LiveKit container + config. Call/participant tables. Call lifecycle API (start, join, leave, end). LiveKit token generation. LiveKit webhook handler. Frontend: call controls, voice panel, huddle banner, incoming call overlay, video grid, screen share. Call event system messages. Call history.

### Phase 4 — BigBlueBam Integration (0.5–1 week)
Share to Banter from BBB. Entity embed cards. Task reference detection. Activity feed bot. Banter mentions in BBB task detail. Top nav with unread badge.

### Phase 5 — Admin, Organization & Search (0.5–1 week)
Channel groups, user groups. Admin settings (including voice/video provider config with test buttons). Channel browser, pins, bookmarks. Full-text message search + transcript search. Channel archive/delete.

### Phase 6 — AI Voice Agent (1–1.5 weeks)
voice-agent container. STT adapters (Deepgram, Google, OpenAI, self-hosted Whisper). TTS adapters (ElevenLabs, Google, OpenAI, self-hosted Piper). LLM integration (Claude + MCP tools). Voice pipeline (STT → LLM → TTS → LiveKit). Filler response pattern. Agent spawn/despawn API. "Invite Agent" button. Agent text sidebar (fallback). Graceful degradation. Live transcription.

### Phase 7 — MCP Server & Notifications (0.5–1 week)
44 new MCP tools (including 10 call/voice tools). 8 resources, 4 prompts. Notifications (in-app + email, per-channel, DND, batching). Call recap prompt.

### Phase 8 — Polish & Scale (0.5–1 week)
Compact mode, dark mode, keyboard shortcuts. Responsive/mobile. Call recording (LiveKit Egress → MinIO). Transcript finalization. Data retention workers. Message partitioning. WebSocket + call horizontal scaling. Performance testing. docker-compose.voice.yml for self-hosted STT/TTS.

---

## 18. Open Questions & Future Considerations

1. **Message scheduling:** Schedule messages for future delivery? Useful for async teams across timezones.
2. **Workflows/automations:** "When a message contains 'deploy', trigger CI/CD." Event → condition → action rules.
3. **External integrations:** GitHub, Sentry, CI/CD posting to Banter channels. Inbound webhooks.
4. **Slash commands:** `/remind`, `/poll`, `/standup`. Extensible command registry.
5. **User-defined sidebar sections:** Personal channel organization beyond admin groups.
6. **Guest access:** Limited external users in specific channels.
7. **Message export:** Channel history as JSON, CSV, PDF.
8. **Custom emoji table:** Migrate from JSONB to dedicated table at scale.
9. **Call breakout rooms:** Split large calls into smaller groups.
10. **Call scheduling:** Schedule with calendar invite. iCal feed integration.
11. **Multi-language STT/TTS:** Automatic language detection.
12. **Voice agent personality:** Per-org or per-channel system prompts for AI voice style.
13. **Call analytics dashboard:** Frequency, duration, active channels, agent participation.
14. **Noise cancellation models:** Self-hosted RNNoise as alternative to browser-native.

---

## See Also

- **[BigBlueBam Design Document v1.0](BigBlueBam_Design_Document.md)** — Core project management tool. Shared auth, database, infrastructure.
- **[BigBlueBam Design Document v2 Addendum](BigBlueBam_Design_Document_v2.md)** — Additional features: imports, reporting, developer workflow.
- **[BigBlueBam Helpdesk Design Document](BigBlueBam_Helpdesk_Design_Document.md)** — Customer ticketing portal.
- **[Architecture Overview](architecture.md)** — System architecture, Docker topology, tech stack rationale.
- **[MCP Server Documentation](mcp-server.md)** — MCP tools, resources, prompts. Banter extends with 44 new tools.
- **[API Reference](api-reference.md)** — BigBlueBam REST API conventions. Banter follows the same patterns.
- **[Database Documentation](database.md)** — Shared PostgreSQL schema. Banter tables prefixed `banter_`.

---

*Awaiting approval to proceed with implementation.*
