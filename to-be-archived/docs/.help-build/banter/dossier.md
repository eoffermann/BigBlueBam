# Banter — App Dossier

Research dossier for the help writer. Everything below is grounded in code; file
paths are absolute. Where docs/marketing disagree with code it is flagged under
Discrepancies.

---

## 1. App Identity

- **app_key:** `banter`
- **Display name:** Banter (often "Banter — Team Messaging" in docs)
- **Category:** Team chat & calls
- **Status:** BETA (a "beta" pill renders in the sidebar header — `apps/banter/src/components/sidebar/banter-sidebar.tsx` ~line 115)
- **SPA path:** `/banter/` (nginx serves the standalone SPA)
- **API path:** `/banter/api/` → proxies to banter-api (internal `:4002`)
- **WebSocket:** `/banter/ws` → `apps/banter-api/src/ws/handler.ts`
- **Frontend dir:** `apps/banter/src` (standalone app, NOT under `apps/frontend/src`)
- **Backend dir:** `apps/banter-api/src`
- **MCP tools:** `apps/mcp-server/src/tools/banter-tools.ts` (54 tools) + `apps/mcp-server/src/tools/banter-subscription-tools.ts` (3 tools)
- **Prerequisites:**
  - Must be **logged into BigBlueBam (Bam) first**. Banter has no login of its own; unauthenticated visitors see "Please log in to BigBlueBam first to access Banter" with a link to `/b3/` (`apps/banter/src/App.tsx` ~lines 198-211).
  - Banter does **not own its user table** — users are shared Bam `users` records (`apps/banter-api/src/routes/user.routes.ts` header; `apps/banter-api/src/db/schema/bbb-refs.ts`).
  - Auth via session cookie (`session`) or Bearer API key. WS auth uses the `session` cookie only (`apps/banter-api/src/ws/handler.ts` ~line 52).
  - Client forwards `X-Org-Id` for multi-org tabs (`apps/banter/src/lib/api.ts` ~lines 46-55).

---

## 2. Key Concepts & Vocabulary

- **Channel** (`banter_channels`, `apps/banter-api/src/db/schema/channels.ts`): a conversation space. `type` ∈ `public | private | dm | group_dm` (default `public`). Has `name`, `slug` (unique per org), optional `display_name`, `topic` (≤500), `description`, `icon` (≤10), `is_archived`, `is_default`, `allow_bots`, `allow_huddles`, `message_retention_days`, denormalized `message_count`/`member_count`/`last_message_at`/`last_message_preview`, `active_huddle_id`, `quiet_hours_policy` (JSONB), `agent_subscription_policy` (JSONB, default `{allow:false, allowed_agent_ids:[]}`), optional `project_id`.
  - **#general auto-creation:** on first `GET /v1/channels` (or first create) for an org with no channels, `#general` is created, marked `is_default`, and every active org member is auto-joined (creator = owner). (`channel.routes.ts` ~lines 102-169, ~360-432.)
- **Channel membership** (`banter_channel_memberships`): per-channel `role` ∈ `owner | admin | member | viewer` (CHECK), `notifications`, `is_muted`, `last_read_message_id`, `last_read_at`. **Viewer is read-only** (enforced in `message.routes.ts` POST, ~lines 253-268).
- **Message** (`banter_messages`): `content` (HTML, sanitized), `content_plain`, `content_format` ∈ `html | markdown | plain` (default html), `thread_parent_id` (non-null = thread reply), `is_system`, `is_bot`, `is_edited`, `is_deleted` (soft delete), `edit_permission` ∈ `own | thread_starter | none` (CHECK, default `own`), `also_sent_to_channel`, `reply_count`, `reply_user_ids` (cap 5), `reaction_counts` (JSONB), `attachment_count`, `has_link_preview`, `metadata`. Max 40 000 chars.
- **Thread:** replies hang off a parent via `thread_parent_id`; a reply can be mirrored to the main timeline with **"Also send to channel"** (`also_sent_to_channel`).
- **DM / Group DM:** `type='dm'` (2 members) or `type='group_dm'` (3-8 total). UI resolves the counterparty via `dm_other_participant` (name + avatar + presence).
- **Reaction** (`banter_message_reactions`): unique `(message_id, user_id, emoji)`, toggle; `reaction_counts` JSONB kept in sync.
- **Pin** (`banter_pins`): channel-wide (visible to all), channel-admin gated. **Bookmark** (`banter_bookmarks`): per-user private save, optional `note` (≤500), unique per `(user_id, message_id)`.
- **Channel group** (`banter_channel_groups`): sidebar buckets (`name`, `position`, `is_collapsed_default`, optional `project_id`). Admin-managed.
- **User group** (`banter_user_groups` / `..._memberships`): org-level @mention groups (e.g. `@engineering`) with `name`, `handle`, `description`. Admin-managed.
- **Presence** (`banter_user_presence`, `services/presence.service.ts`): `status` ∈ `online | idle | in_call | dnd | offline`, plus `in_call_channel_id`, `custom_status_text`, `custom_status_emoji`. Sidebar/members also derive coarse presence from `users.last_seen_at` (online <5min, idle <30min, else offline).
- **Call / Huddle** (`banter_calls`/`_participants`/`_transcripts`): **read-only in the API now.** Banter no longer owns voice/video; live audio is the suite-wide **Bureau docked-box** (room `huddle-banter-{channel_id}`). All call WRITE endpoints return HTTP **410 Gone** (`call.routes.ts` header + ~lines 83-122). Call types: `voice | video | huddle`. Status: `active | ended`.
- **Scheduled message** (`banter_scheduled_messages`): `status` ∈ `pending | delivered | cancelled | failed`; `defer_reason` ∈ `scheduled | quiet_hours`. Worker delivers at `scheduled_at`.
- **Quiet hours policy** (per-channel JSONB): `{ timezone, allowed_hours:[start,end], weekday_only?, urgency_override? }`. Posting inside a quiet window → 409 `QUIET_HOURS` unless `defer_if_quiet` or both caller+policy consent to `urgency_override`. (`message.routes.ts` ~lines 300-467; `services/quiet-hours.service.ts`.)
- **Agent pattern subscription** (`banter_agent_subscriptions`): an agent/service user subscribes a channel with a `pattern_spec`; matches fire `banter.message.matched`. Kinds: `interrogative`, `keyword`, `regex` (admin-only), `mention`.
- **Org-level Banter settings** (`banter_settings`): one row per org — `allow_channel_creation` (`members`/`admins`), `allow_dm`, `allow_group_dm`, `allow_guest_access`, retention, file limits, link previews, BBB integration, LiveKit + STT/TTS/voice-agent config. Some fields overlap Bam `OrgPermissions`, read via `services/org-permissions-bridge.ts` (`getEffectiveBanterPermissions`).

---

## 3. Backend REST Routes (complete enumeration)

All routes mounted at `/v1/...`, proxied at `/banter/api/v1/...`. Auth: `requireAuth` everywhere except the LiveKit webhook + internal routes. `requireScope('read_write'|'admin')` gates mutations; many writes also pass `fastify.requireCan('banter.<permission>')`. Per-route rate limits in `apps/banter-api/src/server.ts` ~lines 125-160.

### Channels — `apps/banter-api/src/routes/channel.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/channels` | List user's channels (org-scoped, non-archived) with `unread_count`, `role`, `is_muted`, `dm_other_participant`. Auto-creates `#general`. |
| POST | `/v1/channels` | Create. Body `{name (lowercase-alnum-hyphen ≤80), type=public|private, topic?, description?, channel_group_id?}`. Enforces `members_can_create_channels` / `members_can_create_private_channels`; re-reads settings (`SETTING_CHANGED`). First channel in empty org forced to `#general`. 5/hr. Emits Bolt `channel.created`. |
| POST | `/v1/channels/bulk` | "Add many." Body `{channels:[{name,type?,topic?,description?}] (1-50), type?}`. Per-row `created|duplicate|invalid|error`. 10/hr. |
| GET | `/v1/channels/browse` | List public non-archived channels. |
| GET | `/v1/channels/by-name/:name` | Resolver: name/slug/`#name` → `{id,name,handle,type,description}` or `{data:null}`. Hides private the caller can't see. |
| GET | `/v1/channels/:id` | Detail (UUID or slug). 404 (not 403) for private non-members. Adds `dm_other_participant`. |
| PATCH | `/v1/channels/:id` | Update (channel admin): name/slug, display_name, topic, description, icon, channel_group_id, allow_bots, allow_huddles, message_retention_days. (Also archive via `{is_archived:true}` from MCP.) |
| DELETE | `/v1/channels/:id` | Soft delete = **archive** (channel owner, or org owner/admin/superuser). Atomic ownership re-check. |
| POST | `/v1/channels/:id/join` | Join a **public** channel. 403 otherwise. |
| POST | `/v1/channels/:id/leave` | Leave. Blocks the **last owner** if others remain (`LAST_OWNER_CANNOT_LEAVE`). |
| GET | `/v1/channels/:id/members` | List members (role, joined_at, is_muted). |
| POST | `/v1/channels/:id/members` | Add members (channel admin). Body `{user_ids[1-100], role?}`. |
| DELETE | `/v1/channels/:id/members/:userId` | Remove member (channel admin). |
| PATCH | `/v1/channels/:id/members/:userId` | Change member role (channel owner). Blocks demoting the last owner. |
| POST | `/v1/channels/:id/mark-read` | Set `last_read_message_id`; Redis cache; broadcasts `channel.read_cursor_synced`. |

### Messages — `apps/banter-api/src/routes/message.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/channels/:id/messages` | Cursor-paginated (`before`/`cursor`/`after`, `limit` ≤100). Top-level + mirrored thread replies. Carries `is_pinned`, `is_bookmarked`, `is_edited`, `thread_reply_count`. |
| POST | `/v1/channels/:id/messages` | Post. Body `{content (1-40000), content_format?, thread_parent_id?, metadata?, edit_permission?, scheduled_at?, defer_if_quiet?, urgency_override?}`. Viewer rejected. DOMPurify sanitized. Scheduled (202) + quiet-hours (409 `QUIET_HOURS` / 202 deferred). @mention/DM/thread notifications. Bolt `message.posted` + `message.mentioned`. 30/min. |
| GET | `/v1/messages/:id` | Single message + author. |
| PATCH | `/v1/messages/:id` | Edit. Honors `edit_permission`; org admins/owners always allowed. Bolt `message.edited`. |
| DELETE | `/v1/messages/:id` | Soft delete (own, or channel/org admin). Broadcasts `message.deleted`. |

### Threads — `apps/banter-api/src/routes/thread.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/messages/:id/thread` | List replies (cursor). |
| POST | `/v1/messages/:id/thread` | Reply. Body `{content, content_format?, also_send_to_channel?}`. Updates parent counters. Notifies parent author + prior repliers + @mentions. Bolt `message.posted` (is_reply) + `message.mentioned`. |

### Reactions — `apps/banter-api/src/routes/reaction.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| POST | `/v1/messages/:id/reactions` | Toggle. Body `{emoji}`. Add emits Bolt `reaction.added`. 60/min. |
| GET | `/v1/messages/:id/reactions` | List grouped by emoji with users. |

### Pins — `apps/banter-api/src/routes/pin.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/channels/:id/pins` | List pins (member). |
| POST | `/v1/channels/:id/pins` | Pin (channel **admin**). Body `{message_id}`. |
| DELETE | `/v1/channels/:id/pins/:messageId` | Unpin (channel admin). |

### Bookmarks — `apps/banter-api/src/routes/bookmark.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/bookmarks` | List user's bookmarks (flat: channel name/slug, preview, author). |
| POST | `/v1/bookmarks` | Create. Body `{message_id, note?}`. |
| DELETE | `/v1/bookmarks/by-message/:messageId` | Remove by message id (toggle-off). |
| DELETE | `/v1/bookmarks/:id` | Remove by bookmark id. |

### DMs — `apps/banter-api/src/routes/dm.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| POST | `/v1/dm` | Create/reuse 1:1 DM. Body `{user_id}`. Validates same-org/active. |
| POST | `/v1/group-dm` | Create group DM. Body `{user_ids[2-7]}` (3-8 total). Gated `members_can_create_group_dms`. |
| GET | `/v1/dm` | List DMs + group DMs. |

### Search — `apps/banter-api/src/routes/search.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/search/messages` | Postgres FTS over `content_plain`, `ts_headline` `<mark>` snippets. Filters: `channel_id`, `author_id`, `before`, `after`, `has_attachments`. Member+org scoped. 20/min. |
| GET | `/v1/search/channels` | ILIKE over name/display_name/topic/description (public + member-visible). 20/min. |
| GET | `/v1/search/transcripts` | FTS over call transcript segments (member-scoped). |

### Calls (read-only; writes 410) — `apps/banter-api/src/routes/call.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/channels/:id/calls` | Call history. |
| GET | `/v1/calls/:id` | Detail + participants. |
| GET | `/v1/calls/:id/participants` | Participants. |
| GET | `/v1/calls/:id/transcript` | Transcript. |
| POST/PATCH | `/v1/channels/:id/calls`, `/v1/calls/:id/{join,leave,end,invite-agent,remove-agent}`, `/v1/calls/:id`, `/v1/calls/:id/media-state` | **All HTTP 410 Gone** (`X-Deprecated-Replacement: bureau-docked-box`). |

### Presence — `apps/banter-api/src/routes/presence.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/me/presence` | Current user's presence row. |
| POST | `/v1/me/presence` | Upsert `{status?, in_call_channel_id?, custom_status_text?, custom_status_emoji?}`. Broadcasts org-wide. |
| GET | `/v1/channels/:id/presence` | Non-offline members of a channel. |

### Preferences & unread — `apps/banter-api/src/routes/preference.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/me/preferences` | Prefs (defaults if none): `default_notification_level (all|mentions|none)`, `sidebar_sort`, `sidebar_collapsed_groups`, `theme_override`, `enter_sends_message`, `show_message_timestamps`, `compact_mode`, `auto_join_huddles`, `noise_suppression`. |
| PATCH | `/v1/me/preferences` | Upsert prefs. |
| GET | `/v1/me/unread` | `{total_unread, channels:[{channel_id, unread_count}]}`. |

### Scheduled messages — `apps/banter-api/src/routes/scheduled-messages.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/channels/:id/scheduled-messages` | List by `status` (default pending). |
| DELETE | `/v1/scheduled-messages/:id` | Cancel pending (author or org staff). `pending`→`cancelled` only. |

### User resolvers — `apps/banter-api/src/routes/user.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/users/by-email?email=` | Exact email → user or null. |
| GET | `/v1/users/by-handle/:handle` | Slug-of-display-name → user or null. |
| GET | `/v1/users/search?q=&limit=` | Fuzzy name/email; no q = 20 most recent. |

### User groups — `apps/banter-api/src/routes/user-group.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/user-groups` | List. |
| POST | `/v1/user-groups` | Create (admin). Body `{name, handle, description?}`. |
| GET | `/v1/user-groups/by-handle/:handle` | Resolver → group + member_count or null. |
| PATCH | `/v1/user-groups/:id` | Update (admin). |
| DELETE | `/v1/user-groups/:id` | Delete (admin). |
| POST | `/v1/user-groups/:id/members` | Add members (admin). |
| GET | `/v1/user-groups/:id/members` | List members. |
| DELETE | `/v1/user-groups/:id/members/:userId` | Remove member (admin). |

### Files — `apps/banter-api/src/routes/file.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| POST | `/v1/files/upload` | Multipart → MinIO (`banter/uploads/`). MIME allowlist (image/audio/video + docs/zip; SVG blocked). Org `max_file_size_mb` (default 25). 10/min. Returns `{url,key,filename,content_type,size_bytes}`. |
| POST | `/v1/files/presigned-upload` | Presigned PUT (1h). Same checks. |

### Link preview — `apps/banter-api/src/routes/link-preview.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/link-preview?url=` | og:title/description/image/site_name/favicon; 10-min cache; rejects internal hosts; 64KB cap. |

### Admin — `apps/banter-api/src/routes/admin.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/v1/admin/settings` | Org settings (secrets masked); auto-creates default row. |
| PATCH | `/v1/admin/settings` | Update org settings (channel-creation policy, DM/group-DM toggles, retention, file size/types, link previews, voice/video + LiveKit + STT/TTS/voice-agent). Audited; pushes voice config. |
| POST | `/v1/admin/settings/test-livekit` | Test LiveKit creds. |
| POST | `/v1/admin/settings/test-stt` | Test STT (deepgram/whisper/openai). |
| POST | `/v1/admin/settings/test-tts` | Test TTS (elevenlabs/openai). |
| POST | `/v1/admin/settings/push-voice-config` | Push STT/TTS/LLM config to voice agent. |
| GET | `/v1/admin/channel-groups` | List channel groups. |
| POST | `/v1/admin/channel-groups` | Create. |
| GET | `/v1/admin/channel-groups/:id` | Get. |
| PATCH | `/v1/admin/channel-groups/:id` | Update. |
| DELETE | `/v1/admin/channel-groups/:id` | Delete. |
| POST | `/v1/admin/channel-groups/reorder` | Reorder by `{order:[{id,position}]}`. |

### Slack import — `apps/banter-api/src/routes/slack-import.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| POST | `/v1/admin/import/slack/upload` | Multipart `.zip` → MinIO + preview. Gated `banter.admin_import.create`. |
| GET | `/v1/admin/import/slack/:id/preview` | Full users/channels for the wizard. |
| POST | `/v1/admin/import/slack/:id/start` | Persist mapping (user `auto_match|send_invite|stub|map_existing|skip`; channel `import_new|merge_existing|skip`; project create/use; options preserve_timestamps, attachments/reactions/pins/dms, dry_run, rate cap) + enqueue worker. |
| GET | `/v1/admin/import/slack/:id/status` | Poll the durable import row. |
| GET | `/v1/admin/import/slack/` | List recent imports. |
| DELETE | `/v1/admin/import/slack/:id` | Abort + cleanup (`cleanup_stubs?`). |

### Agent subscriptions — `apps/banter-api/src/routes/agent-subscriptions.routes.ts`
| Method | Path | Purpose / notes |
|---|---|---|
| POST | `/v1/channels/:id/agent-subscriptions` | Create (subscriber defaults to caller; kind agent/service). Returns `effective` + `reason` if blocked. |
| DELETE | `/v1/agent-subscriptions/:sid` | Disable (subscriber or SuperUser). Idempotent. |
| GET | `/v1/agent-subscriptions` | List caller's subscriptions. |
| GET | `/v1/channels/:id/agent-subscriptions` | List on a channel (channel admin). |

### Webhooks + Internal
- POST `/v1/webhooks/livekit` (`webhook.routes.ts`) — LiveKit room/participant events → `banter_calls`/participants + presence. HMAC-verified per org secret.
- Internal (`internal.routes.ts`, `X-Internal-Secret`): POST `/v1/internal/feed` (post activity-feed message), `/v1/internal/dm` (DM between two users — Bureau leave-a-note), `/v1/internal/share` (share Bam/Helpdesk entity), `/v1/internal/transcription-callback`, `/v1/internal/transcript`.

**Error envelope:** `{ error: { code, message, details[], request_id } }`. Notable codes: `QUIET_HOURS`, `INVALID_SCHEDULED_AT`, `SETTING_CHANGED`, `LAST_OWNER_CANNOT_LEAVE`, `GONE`, `SSRF_BLOCKED`.

---

## 4. Frontend Inventory (views, panels, dialogs, exact labels)

Router: `apps/banter/src/App.tsx`. Base `/banter`. Routes: `/channels/:slug`, `/dm/:id`, `/go/:channelId` (id→canonical redirect), `/browse`, `/bookmarks`, `/search`, `/settings`, `/admin`, `/admin/calling`, `/calls/:id`, `/help`. Default → `/channels/general`.

### Layout shell — `apps/banter/src/pages/banter-layout.tsx`
Left sidebar (260px, collapsible), main column, optional right **Thread panel** (400px), Launchpad switcher (top-left), **breadcrumbs**, **Org switcher**, header **search input** (placeholder `"Search messages..."`, Enter → `/search?q=`), **Notifications bell**, **User menu**. Breadcrumb labels: `Channels`/`#<name>`, `Direct Messages`/`<name>`, `Browse channels`, `Bookmarks`, `Search`, `Settings`, `Admin`, `Admin > Calling Settings`, `Calls > Playback`.

### Sidebar — `apps/banter/src/components/sidebar/banter-sidebar.tsx`
- Header: logo + **"Banter"** wordmark + **"beta"** pill.
- Quick actions: **"Bookmarks"**, **"Browse channels"**, (admins) **"Calling settings"**.
- **"Channels"** section (collapsible) + **"+"** button:
  - Left-click → inline **"New Channel"** box (input `"channel-name"`, **"Create"**).
  - Right-click (admins) → **"Add many channels"** dialog. Tooltip `"Create channel — right-click to add many"`.
  - Per-channel hover menu: **"Rename"**, **"Channel settings"**, **"Leave channel"**, **"Delete channel"** → **"Click again to confirm"** (Delete/Leave hidden for default channel).
  - Unread badge (mentions) / unread dot.
- **"Direct Messages"** section: existing DMs + org members to start a DM (presence dot). Error: **"Couldn't load people — tap to retry"**; empty: **"No team members found"**.
- Footer: shared `SidebarPlatformFooter`.

### Channel view — `apps/banter/src/pages/channel-view.tsx`
Header: `#` + channel name, optional topic (after `|`), right buttons: member count (Users), **"Pinned messages"** (Pin), **"Channel settings"** (Settings). Body: `MessageTimeline`; footer: `TypingIndicator` + `MessageCompose`. No in-channel call button (Bureau docked-box handles audio).

### Message compose — `apps/banter/src/components/messages/message-compose.tsx`
Toolbar (titles): **"Bold"**, **"Italic"**, **"Code"**, **"Link"**, **"Attach file"**, **"Emoji"**. Textarea placeholder `"Message #<channel>"`. @mention autocomplete. Hint: **"Enter to send, Shift+Enter for newline"**. Send button. Attachment preview: **"N files attached"** / **"Remove all"** / **"Uploading..."**. 24-emoji palette.

### Message item — `apps/banter/src/components/messages/message-item.tsx`
Author name, **"BOT"** badge, timestamp, **"(edited)"**, lock icon (`edit_permission='none'`, *"This message is locked — nobody may edit it."*), crown (`thread_starter`). Hover bar: **"Add reaction"** (👍 ❤️ 😂 🎉 👀 🚀), **"Reply in thread"**, **"Pin message"/"Unpin message"**, **"Bookmark"/"Remove bookmark"**, more-menu (**"Edit message"** own-only, **"Delete message"** own, **"Bookmark"/"Remove bookmark"**, **"Pin to channel"/"Unpin from channel"**). Inline edit: **"Save"**/**"Cancel"** + *"Enter to save, Esc to cancel"*. Feedback pills: **"Pinned to channel"**, **"Unpinned"**, **"Bookmarked"**, **"Bookmark removed"**, *"Couldn't pin — channel admins only"*. Thread link: **"N reply/replies"**. System call messages centered with phone icons. Reaction badges (emoji+count); attachments (filename + KB).

### Thread panel — `apps/banter/src/components/threads/thread-panel.tsx`
Header **"Thread"** + close. Parent echo + **"N reply/replies"**. Composer: placeholder `"Reply..."`, checkbox **"Also send to channel"**, send.

### Channel browser — `apps/banter/src/pages/channel-browser.tsx`
Header **"Browse Channels"**, input `"Search channels..."`. Per channel: `#`+name, **"Private"** pill, topic, **"N members"**, **"Last active …"**. Action: **"Join"** / **"Joined"**. Empty: **"No channels found"** / **"Try a different search term"**.

### Bookmarks — `apps/banter/src/pages/bookmarks.tsx`
Header **"Bookmarks"**. Rows: channel link · author · time + preview. Actions: **"Go to message"**, **"Remove bookmark"**. Empty: **"No bookmarks yet"** / *"Bookmark messages to save them for later reference"*.

### Search — `apps/banter/src/pages/search.tsx`
Header **"Search"**. Input `"Search messages..."` + **"Filters"** (count badge). Filters: **"Channel"** (`All channels`), **"Author"** (`Anyone`), **"From date"**, **"To date"**, **"Has attachments"**, **"Clear all filters"**. Result rows: channel · author · time + snippet. Empty: **"Search across all channels"** / **"Find messages, files, and more"**; **"No results found"** / **"Try different keywords"**. (Calls `/search` not `/search/messages` — confirmed bug, Discrepancies #2.)

### Channel settings modal — `apps/banter/src/components/channels/channel-settings.tsx`
Title **"Channel Settings"**. Fields **"Channel name"**, **"Topic"**, **"Description"**. Toggles **"Allow bots"**, **"Allow huddles"**. **"Save Changes"** → **"Saved!"**. **"Members (N)"** + add-member input (`"Email or username"`) + **"Add"**. **"Danger Zone"** (non-default): **"Delete Channel"** → *"Are you sure you want to delete #<name>? This will archive the channel and all its messages. This action cannot be undone."* + **"Yes, delete channel"** / **"Cancel"**. (Add-member posts `{identifier}` but API expects `{user_ids:[]}` — Discrepancies #4.)

### Bulk-create dialog — `apps/banter/src/components/sidebar/bulk-create-channels-dialog.tsx`
Title **"Add many channels"**, *"Paste one channel name per line. Up to 50 at a time."* Parse summary (`N valid`/`N duplicate`/`N invalid`/`Over 50-channel limit`). Toggle **"Public"**/**"Private"**. Submit **"Create N channels"** → **"Create remaining"**. Results: `created`/`duplicate`/`invalid`/`error`.

### Preferences — `apps/banter/src/pages/preferences.tsx`
Header **"Preferences"**. Sections **"Profile"**, **"Theme"** (`Light`/`Dark`/`System`), **"Notifications"** (`Desktop notifications`, `Notification sound`), **"Messaging"** (`Enter to send`, `Show typing indicators`, `Compact mode`). **"Save Preferences"**. Theme in `localStorage` (`bbam-theme`). (Field shape ≠ backend schema — Discrepancies #3.)

### Admin — `apps/banter/src/pages/admin.tsx`
Header **"Banter Administration"**. Sections **"Voice & Video"** (Enable voice & video calls, LiveKit Host/API Key/API Secret, **"Test Connection"**), **"Channel Settings"** (Default Channel, **"Who can create channels"**: `Everyone`/`Admins only`/`Organization owners only`), **"Message Settings"** (retention days, max file size), Voice Agent / STT / TTS / LLM block (Whisper/Deepgram/Google/OpenAI; Piper/ElevenLabs/Google/OpenAI; Anthropic/OpenAI).

### Other pages
- Admin calling settings (`admin-calling-settings.tsx`, `/admin/calling`) — dedicated calling/STT/TTS/voice-agent config; sidebar **"Calling settings"**.
- Call playback (`call-playback.tsx`, `/calls/:id`) — read-only: type icon (voice/video/huddle), duration, participants, transcript.

### Keyboard shortcuts — `apps/banter/src/hooks/use-keyboard-shortcuts.ts`
**Ctrl/Cmd+K** quick channel switcher, **Ctrl/Cmd+Shift+M** toggle mute, **Esc** close thread/switcher, **?** open Help, **↑** in empty compose edit last message.

### Realtime / WS — `apps/banter-api/src/ws/handler.ts`
Auto-joins `banter:user:<id>` + `banter:org:<id>`; `subscribe`/`unsubscribe` channel rooms (membership-checked); `typing.start`/`typing.stop`. Broadcasts message/reaction/pin/member/channel/presence events. 100 msgs/10s (close 4029).

---

## 5. MCP Tools

### `apps/mcp-server/src/tools/banter-tools.ts` — `registerBanterTools` (54)
Channel/user args accept UUID, name/`#name`, or email/`@handle` (resolved via `/v1/channels/by-name`, `/v1/users/by-email|by-handle`).
- **Channels (11):** `banter_list_channels`, `banter_get_channel`, `banter_get_channel_by_name`, `banter_create_channel`, `banter_update_channel`, `banter_archive_channel`, `banter_delete_channel` (confirm_action), `banter_join_channel`, `banter_leave_channel`, `banter_add_channel_members`, `banter_remove_channel_member`.
- **Messages (9):** `banter_list_messages`, `banter_get_message`, `banter_post_message`, `banter_schedule_post` (scheduled_at required), `banter_edit_message`, `banter_delete_message` (confirm), `banter_react`, `banter_pin_message`, `banter_unpin_message`.
- **Threads (2):** `banter_list_thread_replies`, `banter_reply_to_thread`.
- **Search (3):** `banter_search_messages`, `banter_browse_channels`, `banter_search_transcripts`.
- **DMs (2):** `banter_send_dm`, `banter_send_group_dm` (create-or-reuse then post in one call).
- **User resolvers (3):** `banter_find_user_by_email`, `banter_find_user_by_handle`, `banter_list_users`.
- **User groups (6):** `banter_list_user_groups`, `banter_get_user_group_by_handle`, `banter_create_user_group`, `banter_update_user_group`, `banter_add_group_members`, `banter_remove_group_member`.
- **Calls (10):** `banter_start_call`, `banter_join_call`, `banter_leave_call`, `banter_end_call` (confirm), `banter_get_call`, `banter_list_calls`, `banter_get_transcript`, `banter_invite_agent_to_call`, `banter_post_call_text`, `banter_get_active_huddle`. **Write call tools hit 410'd endpoints — Discrepancies #1.**
- **Integration (4):** `banter_share_task`, `banter_share_sprint`, `banter_share_ticket`, `banter_get_unread`.
- **Preferences & presence (3):** `banter_get_preferences`, `banter_update_preferences`, `banter_set_presence`.

### `apps/mcp-server/src/tools/banter-subscription-tools.ts` — `registerBanterSubscriptionTools` (3)
`banter_subscribe_pattern` (interrogative/keyword/regex admin-only/mention; fires `banter.message.matched`), `banter_unsubscribe_pattern` (idempotent), `banter_list_subscriptions`.

Destructive tools (`banter_delete_channel`, `banter_delete_message`, `banter_end_call`) require an explicit confirm flag.

---

## 6. Candidate User Stories

1. **Send a message.** Open channel → compose (Bold/Italic/Code/Link, @mention, emoji, attach) → Enter. (`POST /v1/channels/:id/messages`.)
2. **Create a channel.** Channels "+" → name → "Create". (`POST /v1/channels`.) Admins: right-click "+" → "Add many".
3. **Browse & join.** "Browse channels" → search → "Join". (`/channels/browse`, `/channels/:id/join`.)
4. **Start a DM / group DM.** Sidebar → click member (or group). (`/dm`, `/group-dm`.)
5. **Reply in a thread.** Hover → "Reply in thread" → optionally "Also send to channel". (`/messages/:id/thread`.)
6. **React, pin, bookmark.** Hover actions. (`/reactions`, `/pins`, `/bookmarks`.)
7. **Edit / delete your message.** More-menu. (`PATCH`/`DELETE /messages/:id`.)
8. **Search messages.** Header search or "/search" with filters. (`/search/messages`.)
9. **Schedule a post / quiet hours.** `scheduled_at` or `defer_if_quiet`; manage via `/scheduled-messages`. (Driven via MCP/automation; no in-UI scheduler found.)
10. **Configure a channel.** Settings modal: name/topic/description, allow bots/huddles, members, delete (archive). (`PATCH /channels/:id`.)
11. **Mark a channel read.** Auto on view; cross-device. (`/mark-read`.)
12. **Admin: org policy.** "Banter Administration" → who-can-create, retention, file size, voice/video. (`PATCH /admin/settings`.)
13. **Admin: organize sidebar.** Channel groups CRUD + reorder. (`/admin/channel-groups`.)
14. **Admin: @mention groups.** Create `@engineering`. (`/user-groups`.)
15. **Admin: import Slack.** Upload `.zip` → map → start → poll. (`/admin/import/slack/*`.)
16. **Share a Bam/Helpdesk entity.** Embed a task/sprint/ticket. (MCP `banter_share_*` / `/internal/share`.)
17. **Review a past call.** `/calls/:id` participants + transcript.

---

## 7. Agent Flows

- **Post/schedule/DM/react/pin** via the 54 `banter_*` tools. Canonical Bolt pattern: `banter_post_message` with a `#channel` name.
- **Cross-app announcements** via Bolt rules + `banter_share_task/sprint/ticket`.
- **Passive listening** via `banter_subscribe_pattern` / `POST /v1/channels/:id/agent-subscriptions` → `banter.message.matched` events. Gated by per-channel `agent_subscription_policy` + §15 `agent_policies`; blocked subs recorded with `effective:false` + reason.
- **Presence/prefs** via `banter_set_presence` (ephemeral), `banter_get/update_preferences`, `banter_get_unread`.
- **Bolt events produced (`source:'banter'`):** `channel.created`, `message.posted`, `message.mentioned`, `message.edited`, `reaction.added`, `message.scheduled`, `message.quiet_hours_deferred`, plus `banter.message.matched` (subscription worker). Catalog: `apps/bolt-api/src/services/event-catalog.ts`.
- **HITL/visibility:** per `docs/reference/agent-conventions.md`, agents posting into shared Banter surfaces honor `can_access`; message replies route HITL to the thread author.

---

## 8. Screenshots Available

Dir: `docs/apps/banter/screenshots/{light,dark}/`. Catalog: `docs/apps/banter/meta.json` (1440x900). Light + dark variants of all four.

| File | meta.json label | Depicts | Illustrates |
|---|---|---|---|
| `light|dark/01-channels.png` | "Channel list" | Sidebar Channels/DMs + quick actions | Story 2/3 |
| `light|dark/02-channel-view.png` | "Channel conversation" | Channel timeline + composer | Story 1 |
| `light|dark/03-threads.png` | "Thread view" | Right-hand Thread panel | Story 5 |
| `light|dark/04-dms.png` | "Direct messages" | A DM conversation | Story 4 |

NOTE (unverified): `meta.json` lists the same `sha256` (`8b7e80…`) for light `01-channels` and `02-channel-view` — possibly duplicate captures. Verify visually.

---

## 9. Discrepancies (docs/marketing vs. code)

1. **Voice calls are no longer owned by Banter.** `guide.md`/`marketing.md` advertise "Voice Calls with call recording and playback." In code, all call WRITE endpoints return **HTTP 410 Gone**; live audio is the suite-wide **Bureau docked-box** (room `huddle-banter-{channel_id}`). Only read/playback of historical calls remains. The MCP write call tools (`banter_start_call`, `banter_join_call`, `banter_end_call`, `banter_invite_agent_to_call`, etc.) target the 410'd endpoints and will fail. No in-channel call button in the SPA. Document as "review past calls / playback" + Bureau docked-box, NOT a live Banter feature. (`apps/banter-api/src/routes/call.routes.ts`.)
2. **Frontend Search calls the wrong path (confirmed bug).** `apps/banter/src/pages/search.tsx` issues `api.get('/search', …)`, but the only route is `GET /v1/search/messages`. The client (`apps/banter/src/lib/api.ts`) does NOT rewrite `/search`, so it hits `/banter/api/v1/search` → 404. The in-app Search page (and the header search bar that routes to it) returns no results. Flag loudly.
3. **Preferences shape mismatch.** `apps/banter/src/pages/preferences.tsx` uses `{notification_sound, desktop_notifications, enter_to_send, show_typing_indicators, compact_mode}`; backend `preference.routes.ts` uses `{default_notification_level, sidebar_sort, theme_override, enter_sends_message, show_message_timestamps, compact_mode, auto_join_huddles, noise_suppression}`. Only `compact_mode` overlaps; other toggles likely don't round-trip. Theme is `localStorage` (`bbam-theme`), not the API. Describe visible toggles but don't claim each persists server-side.
4. **Channel-settings add-member body mismatch.** The "Members" add form posts `{identifier}` to `POST /v1/channels/:id/members`, but `addMembersSchema` requires `{user_ids:[uuid]}`. Adding a member from this modal likely 400s. Treat as suspect; verify.
5. **Composer upload reads a missing field.** `message-compose.tsx` reads `result.data.id` from `POST /v1/files/upload`, but the route returns `{data:{url,key,filename,content_type,size_bytes}}` (no `id`). Collected `attachmentIds` end up empty, so composer file attachments may not attach. Verify before documenting "attach a file."
6. **Admin "Who can create channels" options don't all map.** UI offers `Everyone`/`Admins only`/`Organization owners only`; the API setting `allow_channel_creation` accepts only `members | admins`. The third option has no distinct backend value. Confirm mapping.
7. **mcp-tools.md / guide.md are stale.** Generated `docs/apps/banter/mcp-tools.md` and `guide.md` MCP table omit the 3 subscription tools and `banter_schedule_post`, and truncate descriptions. Use the source tool files.

---

## 10. Open Questions

1. **Huddles UX.** `allow_huddles`/`active_huddle_id` exist and the docked-box derives `huddle-banter-{channel_id}`, but there is no Banter-side "Start huddle" button in the channel header. How does a user start a huddle from Banter today — purely via the Bureau docked-box? Confirm.
2. **Agent subscriptions in the SPA?** Only API + MCP surfaces found; no frontend "who is listening here" panel located.
3. **`banter_create_user_group` `user_ids` arg.** The MCP tool accepts initial `user_ids`, but `POST /v1/user-groups` body schema doesn't — dropped or added via a follow-up call? Not resolved.
4. **Where are preferences-page toggles consumed** (`notification_sound`, `desktop_notifications`, `show_typing_indicators`, `enter_to_send`) if the API ignores them? Possibly client-side / no-op.
5. **Duplicate light screenshots?** `01-channels` and `02-channel-view` share a sha256 in `meta.json` — genuine duplicate or metadata error?
6. **Notifications routing.** Banter emits via `apps/banter-api/src/lib/notify.js` (`emitNotification`); the header NotificationsBell uses `inAppPrefix="/banter/"`. The exact bell data source (Bam notifications API) was not traced end-to-end.
