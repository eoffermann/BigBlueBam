# Banter (Team Messaging) Security Assessment

**Date:** 2026-04-09
**Scope:** BigBlueBam Banter API (`apps/banter-api/`) -- REST endpoints, WebSocket handler, webhook receiver, internal routes
**Methodology:** Dual-agent automated code review (Agent 1: Auth/Session/WS; Agent 2: AuthZ/Data/Logic)
**Assessed commit:** `8683337` (branch `beacon`)

---

## Executive Summary

Two independent security audit agents analyzed the Banter API codebase covering authentication, authorization, WebSocket security, data isolation, input sanitization, and business logic. After deduplication, **28 unique findings** were identified:

| Severity      | Count |
|---------------|-------|
| Critical      |     2 |
| High          |     6 |
| Medium        |    14 |
| Low           |     6 |
| Informational |     2 |

The most severe issues center on the **WebSocket handler**, which lacks channel-membership authorization on subscription requests, allowing any authenticated user to eavesdrop on any channel's real-time events. The **internal API routes** are exposed without authentication, meaning any network-adjacent caller can post activity-feed messages or transcript segments. HTML sanitization relies on regex patterns that are trivially bypassable, creating stored XSS risk in messages, thread replies, and message edits.

**Positive findings:** Message search is properly scoped to the caller's channel memberships and org. DM creation validates same-org membership. Pin operations enforce proper channel-level RBAC. Rate limiting is applied to messages, reactions, search, uploads, and channel creation. API key authentication uses Argon2id with timing-safe verification and a DoS-mitigation prefix-candidate cap.

---

## Critical Remediation Path (Top 5 Fixes)

| Priority | Finding ID | Title | Effort |
|----------|------------|-------|--------|
| 1 | BANTER-001 | WS channel subscription lacks authorization | Small |
| 2 | BANTER-003 | Internal routes have no authentication | Small |
| 3 | BANTER-005 | HTML sanitization bypassable (stored XSS) | Medium |
| 4 | BANTER-002 | GET messages missing channel membership check | Small |
| 5 | BANTER-004 | LiveKit webhook signature bypass | Small |

---

## Findings

### BANTER-001 -- WebSocket Channel Subscription Missing Authorization [CRITICAL]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 108-120)

**Description:**
When a WebSocket client sends a `subscribe` message with a room name matching `banter:channel:<uuid>`, the handler adds the room to the client's subscription set without verifying that the authenticated user is a member of the referenced channel. Any authenticated user in any org can subscribe to any channel's real-time event stream.

**Attack scenario:**
1. Attacker authenticates with a valid session cookie and establishes a WebSocket connection.
2. Attacker sends `{"type":"subscribe","room":"banter:channel:<target-channel-id>"}`.
3. The handler adds the room unconditionally.
4. Attacker receives all `message.created`, `message.updated`, `message.deleted`, `typing.start`, `reaction.added`, etc. events for the target channel, including private channels and channels in other organizations.

**Code reference:**
```typescript
case 'subscribe': {
  const room = msg.room as string;
  if (room && room.startsWith('banter:channel:')) {
    client.rooms.add(room);  // No membership or org check
    // ...
  }
  break;
}
```

**Recommended fix:**
Before adding the room, extract the channel ID from the room name, query `banter_channel_memberships` for a row matching `(channel_id, userId)`, and verify the channel's `org_id` matches the client's `orgId`. Reject the subscription with an error frame if the check fails.

---

### BANTER-002 -- GET Messages Endpoint Missing Channel Membership Check [CRITICAL]

**Affected file:** `apps/banter-api/src/routes/message.routes.ts` (lines 35-142)

**Description:**
The `GET /v1/channels/:id/messages` endpoint verifies that the channel exists and belongs to the user's org (`banterChannels.org_id = user.org_id`) but does **not** verify that the requesting user is a member of the channel. For private channels, any authenticated user in the same org can read the full message history.

**Attack scenario:**
1. Attacker is a member of Org A but not a member of private channel `#leadership`.
2. Attacker calls `GET /v1/channels/<leadership-channel-id>/messages`.
3. The endpoint returns all messages because the channel's `org_id` matches the user's org.

**Code reference:**
```typescript
const [channel] = await db
  .select()
  .from(banterChannels)
  .where(and(eq(banterChannels.id, id), eq(banterChannels.org_id, user.org_id)))
  .limit(1);
// No membership check follows -- messages are returned directly
```

**Recommended fix:**
Add a channel-membership check after verifying the channel exists. For private channels, reject non-members with 404 to avoid leaking channel existence. For public channels, consider whether non-members should be able to read history (if not, add the same check). Alternatively, add `requireChannelMember` to the preHandler chain, consistent with the POST message endpoint.

---

### BANTER-003 -- Internal Routes Exposed Without Authentication [HIGH]

**Affected file:** `apps/banter-api/src/routes/internal.routes.ts` (lines 1-100)

**Description:**
The internal routes (`/v1/internal/feed`, `/v1/internal/share`, `/v1/internal/transcript`) are intended for service-to-service calls within the Docker network but have no authentication or authorization middleware. Any caller who can reach the Banter API port (4002) can invoke these endpoints.

The comment on line 17 states "These endpoints don't require user auth since they're called service-to-service," but no alternative authentication (shared secret, mTLS, IP allowlist) is implemented.

**Attack scenario:**
1. If the Banter API port is exposed beyond the Docker network (misconfigured firewall, development environment, port forwarding), an attacker can POST arbitrary activity-feed messages to any channel in any org.
2. Attacker posts a phishing message via `/v1/internal/feed` with `event_type: "bbb.task.shared"`, which appears as a legitimate system message in the channel.

**Recommended fix:**
Add a shared-secret header check (e.g., `X-Internal-Secret` validated against an environment variable) or restrict these routes via an IP allowlist middleware that only allows requests from Docker-internal IPs (172.16.0.0/12, 10.0.0.0/8). At minimum, register these routes under a separate Fastify instance or prefix with a guard hook.

---

### BANTER-004 -- LiveKit Webhook Signature Bypass (Graceful Degradation) [HIGH]

**Affected file:** `apps/banter-api/src/routes/webhook.routes.ts` (lines 117-125)

**Description:**
The LiveKit webhook handler calls `verifyLiveKitSignature()` but proceeds to process the event even when signature verification fails, logging only a warning. This "graceful degradation" approach means an attacker can send forged webhook events to manipulate call state.

**Code reference:**
```typescript
const signatureValid = await verifyLiveKitSignature(authHeader, request.body, fastify.log);
if (!signatureValid) {
  fastify.log.warn('LiveKit webhook: proceeding without verified signature (graceful degradation)');
}
// Event processing continues regardless
```

**Attack scenario:**
1. Attacker sends a forged `room_finished` event with a valid room name.
2. The handler ends the call, marks all participants as left, and broadcasts `call.ended` to the channel.
3. Attacker can also forge `participant_joined` / `participant_left` events to corrupt call participant records.

**Recommended fix:**
Return `401 Unauthorized` when signature verification fails instead of proceeding. If there is a bootstrapping concern where secrets are not yet configured, allow a time-limited startup grace period or environment variable override, not permanent bypass.

---

### BANTER-005 -- Incomplete HTML Sanitization (Stored XSS) [HIGH]

**Affected file:** `apps/banter-api/src/routes/message.routes.ts` (lines 154-158)

**Description:**
Message content is sanitized using regex-based stripping of `<script>` tags, `on*` event handlers, and `javascript:` URLs. This approach is fundamentally bypassable. Regex cannot reliably parse HTML, and numerous bypasses exist.

**Code reference:**
```typescript
sanitizedContent = sanitizedContent.replace(/<script[\s\S]*?<\/script>/gi, '');
sanitizedContent = sanitizedContent.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
sanitizedContent = sanitizedContent.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
```

**Known bypasses:**
- `<img src=x onerror=alert(1)>` -- the `on*` regex requires quotes around the attribute value; unquoted attributes bypass it.
- `<svg/onload=alert(1)>` -- no space before `on`, bypasses `\s+on\w+` pattern.
- `<a href="java\x0ascript:alert(1)">` -- null byte or newline in protocol bypasses string match.
- `<details open ontoggle=alert(1)>` -- unquoted event handler.
- Nested/broken tags: `<scr<script>ipt>alert(1)</script>`.

**Attack scenario:**
An attacker posts a message containing a crafted XSS payload. When other users view the message (rendered as HTML in the frontend), the script executes in their browser context, potentially stealing session cookies or performing actions on their behalf.

**Recommended fix:**
Replace regex sanitization with a proper HTML sanitization library such as `DOMPurify` (server-side via `jsdom`) or `sanitize-html`. Configure an allowlist of safe tags and attributes. Apply the same sanitization to all content-accepting endpoints (messages, thread replies, message edits).

---

### BANTER-006 -- Thread Reply Content Not Sanitized [HIGH]

**Affected file:** `apps/banter-api/src/routes/thread.routes.ts` (lines 153-210)

**Description:**
The `POST /v1/messages/:id/thread` endpoint accepts `content` in the request body and inserts it directly into `banter_messages` without any HTML sanitization. While the main message creation endpoint (`POST /v1/channels/:id/messages`) has (bypassable) regex sanitization, the thread reply endpoint has none at all.

**Code reference:**
```typescript
const [message] = await db
  .insert(banterMessages)
  .values({
    channel_id: parent.channel_id,
    author_id: user.id,
    thread_parent_id: id,
    content: body.content,  // Raw, unsanitized
    // ...
  })
```

**Attack scenario:**
Same as BANTER-005 but via thread replies. Attacker replies to any thread with an XSS payload.

**Recommended fix:**
Apply the same HTML sanitization (preferably using a proper library per BANTER-005) to thread reply content before insertion.

---

### BANTER-007 -- Message Edit Content Not Sanitized [HIGH]

**Affected file:** `apps/banter-api/src/routes/message.routes.ts` (lines 437-494)

**Description:**
The `PATCH /v1/messages/:id` endpoint accepts updated `content` but does not apply any HTML sanitization before saving to the database. An attacker who initially posted a benign message can edit it to contain an XSS payload.

**Code reference:**
```typescript
const [updated] = await db
  .update(banterMessages)
  .set({
    content: body.content,  // Raw, unsanitized
    content_plain: contentPlain,
    // ...
  })
```

**Recommended fix:**
Apply the same HTML sanitization as message creation. Centralize sanitization into a shared function used by all three content-accepting paths (create, thread reply, edit).

---

### BANTER-008 -- WebSocket Missing Origin Validation (CSWSH) [HIGH]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 50-55)

**Description:**
The WebSocket upgrade handler authenticates via the session cookie but does not validate the `Origin` header. This enables Cross-Site WebSocket Hijacking (CSWSH), where a malicious website can open a WebSocket connection to the Banter API using the victim's session cookie (sent automatically by the browser).

**Attack scenario:**
1. Victim is logged into Banter in browser tab A.
2. Victim visits attacker's site in tab B.
3. Attacker's JavaScript opens `new WebSocket("wss://target.com/banter/ws")`.
4. Browser sends the session cookie. The WS handshake succeeds.
5. Attacker subscribes to channels and receives real-time messages.

**Recommended fix:**
Validate the `Origin` header during the WebSocket upgrade against the configured `CORS_ORIGIN` allowlist. Reject connections from unauthorized origins with a `403` before completing the handshake. Note that `@fastify/cors` does not apply to WebSocket upgrade requests.

---

### BANTER-009 -- No WebSocket Message Size Limits [MEDIUM]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 104-180)

**Description:**
The WebSocket message handler parses incoming messages without enforcing a maximum payload size. An attacker can send extremely large messages to exhaust server memory or CPU during JSON parsing.

**Recommended fix:**
Configure `maxPayload` on the WebSocket server (e.g., `{ websocket: true, wsOptions: { maxPayload: 8192 } }` in the route config). Alternatively, check `raw.length` before `JSON.parse`.

---

### BANTER-010 -- No Per-User WebSocket Connection Limits [MEDIUM]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 86-93)

**Description:**
The handler tracks connected clients in a `Map<WebSocket, ConnectedClient>` but does not limit how many concurrent WebSocket connections a single user can open. An attacker can open thousands of connections to exhaust server resources.

**Recommended fix:**
Before adding a new client to the map, count existing entries for the same `userId`. Enforce a per-user cap (e.g., 10 concurrent connections). Close the oldest connection or reject the new one if the limit is exceeded.

---

### BANTER-011 -- Typing Indicator No Channel Membership Check [MEDIUM]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 138-172)

**Description:**
The `typing.start` and `typing.stop` WebSocket message handlers broadcast typing events to the channel room without verifying that the sender is a member of the specified channel. Combined with BANTER-001, an attacker can both subscribe to and send typing indicators for channels they do not belong to.

**Recommended fix:**
Verify the client has a legitimate subscription to the target channel room before broadcasting typing events. Alternatively, check channel membership on each typing event (with Redis caching to avoid per-event DB queries).

---

### BANTER-012 -- Session Cookie Missing Security Attributes [MEDIUM]

**Affected file:** `apps/banter-api/src/plugins/auth.ts` (lines 188-189), `apps/banter-api/src/server.ts` (lines 74-76)

**Description:**
The session cookie is read from `request.cookies?.session` but the cookie plugin is registered with only a `secret` option. There is no enforcement that the session cookie is set with `Secure`, `HttpOnly`, `SameSite=Strict` or `SameSite=Lax` attributes. While cookie setting happens elsewhere (likely the main API), the Banter API's reliance on the cookie without validating these attributes means it is vulnerable if the cookie was set insecurely.

**Recommended fix:**
Ensure the session cookie is set with `Secure: true` (HTTPS only), `HttpOnly: true` (no JS access), and `SameSite: Lax` or `Strict`. Document this requirement for all services that consume the session cookie.

---

### BANTER-013 -- WebSocket Uses Legacy `org_id` From Users Table [MEDIUM]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 63-82)

**Description:**
The WebSocket handler reads `users.org_id` directly to determine the client's org context. The REST auth plugin (`plugins/auth.ts`) uses `resolveOrgContext()` which respects multi-org memberships and the `X-Org-Id` header. This inconsistency means WebSocket connections always use the legacy single-org value, which may be stale or incorrect for multi-org users.

**Recommended fix:**
Replicate the `resolveOrgContext()` logic in the WebSocket handler, or extract the `X-Org-Id` value from the WebSocket upgrade request's query parameters (since headers are fixed at handshake time).

---

### BANTER-014 -- SSRF via Admin STT/TTS Test Endpoints [MEDIUM]

**Affected files:** `apps/banter-api/src/routes/admin.routes.ts` (lines 239-393)

**Description:**
The `POST /v1/admin/settings/test-stt` and `POST /v1/admin/settings/test-tts` endpoints make outbound HTTP requests to URLs derived from org settings. For unknown providers, the handler fetches an arbitrary `url` from the provider config. An org admin can set `stt_provider_config.url` to an internal network address (e.g., `http://169.254.169.254/latest/meta-data/` for AWS metadata, or `http://postgres:5432/` for internal services).

**Code reference:**
```typescript
const url = config.url as string | undefined;
if (url) {
  const res = await fetch(url);  // SSRF: admin-controlled URL
}
```

**Attack scenario:**
An org admin sets the STT provider to "custom" with `url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/"`. The test endpoint fetches this URL from the server, returning AWS IAM credentials to the admin.

**Recommended fix:**
Validate URLs against a denylist of internal/metadata IP ranges (169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, fd00::/8). Additionally, require that URLs use HTTPS. Consider using a purpose-built SSRF-safe HTTP client.

---

### BANTER-015 -- Message Deletion Missing Cross-Org Isolation [MEDIUM]

**Affected file:** `apps/banter-api/src/routes/message.routes.ts` (lines 497-565)

**Description:**
The `DELETE /v1/messages/:id` endpoint looks up the message by ID and checks if the caller is the author or has admin/owner role, but does not verify that the message's channel belongs to the caller's org. An org admin in Org A could delete messages belonging to channels in Org B if they know the message UUID.

**Code reference:**
```typescript
const [existing] = await db
  .select()
  .from(banterMessages)
  .where(and(eq(banterMessages.id, id), eq(banterMessages.is_deleted, false)))
  // No org_id check
  .limit(1);
```

**Recommended fix:**
Join with `banter_channels` and add `eq(banterChannels.org_id, user.org_id)` to the WHERE clause, or look up the channel after finding the message and verify `channel.org_id === user.org_id`.

---

### BANTER-016 -- Message Edit Missing Cross-Org and Channel Membership Check [MEDIUM]

**Affected file:** `apps/banter-api/src/routes/message.routes.ts` (lines 437-494)

**Description:**
The `PATCH /v1/messages/:id` endpoint verifies only that the caller is the message author. It does not verify: (a) the message's channel belongs to the caller's current org, or (b) the caller is still a member of the channel. A user who was removed from a channel (or switched orgs) can still edit their old messages.

**Recommended fix:**
Add org isolation (join with channels, check `org_id`) and optionally re-verify channel membership before allowing edits.

---

### BANTER-017 -- Channel Members Endpoint Leaks Cross-Org Data [MEDIUM]

**Affected file:** `apps/banter-api/src/routes/channel.routes.ts` (lines 812-837)

**Description:**
The `GET /v1/channels/:id/members` endpoint requires only `requireAuth` and does not verify that the requesting user belongs to the same org as the channel or is a member of the channel. Any authenticated user who knows a channel UUID can enumerate its members, including their email addresses and display names.

**Code reference:**
```typescript
fastify.get(
  '/v1/channels/:id/members',
  { preHandler: [requireAuth] },  // No org or membership check
  async (request, reply) => {
    const members = await db
      .select({ /* includes email, display_name */ })
      .from(banterChannelMemberships)
      .where(eq(banterChannelMemberships.channel_id, id));
```

**Recommended fix:**
Add `requireChannelMember` to the preHandler chain, or at minimum verify that the channel's `org_id` matches the caller's org. Consider whether email should be exposed in this endpoint.

---

### BANTER-018 -- Org Admins Auto-Elevated to Channel Admins [MEDIUM]

**Affected file:** `apps/banter-api/src/middleware/channel-auth.ts` (lines 143-146)

**Description:**
The `requireChannelAdmin` middleware grants org-level admins and owners full channel-admin privileges, even if they joined the channel as a regular member. This design decision means org admins can modify channel settings, add/remove members, etc. for every channel in the org, which may not match the intended access model for private channels.

**Code reference:**
```typescript
if (user.is_superuser || ['owner', 'admin'].includes(user.role)) {
  return;  // Org admin bypasses channel role check
}
```

**Recommended fix:**
Evaluate whether org admins should have automatic channel-admin privileges for private channels. Consider requiring explicit channel-admin membership for private channel operations, while retaining the bypass for public channels and org-wide moderation.

---

### BANTER-019 -- Add Members Endpoint Missing Target Org Validation [MEDIUM]

**Affected file:** `apps/banter-api/src/routes/channel.routes.ts` (lines 839-881)

**Description:**
The `POST /v1/channels/:id/members` endpoint accepts an array of `user_ids` and inserts membership records without verifying that the target users belong to the same org as the channel. A channel admin can add users from other orgs to their channel.

**Recommended fix:**
Before inserting memberships, verify that each target user exists, is active, and has `org_id` matching the channel's `org_id` (or the caller's `org_id`).

---

### BANTER-020 -- Remove Member Doesn't Protect Channel Owner [MEDIUM]

**Affected file:** `apps/banter-api/src/routes/channel.routes.ts` (lines 883-923)

**Description:**
The `DELETE /v1/channels/:id/members/:userId` endpoint allows a channel admin to remove any member, including the channel owner. This could result in a hostile channel-admin takeover by removing the owner.

**Recommended fix:**
Before deleting a membership, check if the target user is a channel owner. If so, require the caller to also be a channel owner (not just admin). Also check that removing the owner would not leave the channel ownerless.

---

### BANTER-021 -- WebSocket No Rate Limiting [MEDIUM]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 104-180)

**Description:**
The WebSocket message handler processes every incoming message without rate limiting. An attacker can flood the server with rapid `subscribe`, `typing.start`, and other messages to cause resource exhaustion. The REST API has per-route rate limits, but the WebSocket handler has none.

**Recommended fix:**
Implement a per-client rate limiter (e.g., token bucket) that limits the number of messages processed per second. Drop excess messages and optionally disconnect clients that exceed the limit persistently.

---

### BANTER-022 -- Admin Settings GET Exposes Secrets [MEDIUM]

**Affected file:** `apps/banter-api/src/routes/admin.routes.ts` (lines 70-93)

**Description:**
The `GET /v1/admin/settings` endpoint returns the full `banter_settings` row, which includes `livekit_api_key`, `livekit_api_secret`, and provider config objects that contain API keys (Deepgram, ElevenLabs, OpenAI). The endpoint requires only `requireAuth` (not admin role), so any authenticated user can read these secrets.

**Recommended fix:**
1. Restrict `GET /v1/admin/settings` to admin/owner role (add `requireRole(['owner', 'admin'])` to preHandler).
2. Redact sensitive fields (`livekit_api_secret`, `stt_provider_config`, `tts_provider_config`, `ai_voice_agent_llm_config`) from the response, or replace their values with masked versions (e.g., `"****"`). Only expose secrets in the PATCH response to the admin who set them.

---

### BANTER-023 -- Reaction Emoji Allows Arbitrary Strings [LOW]

**Affected file:** `apps/banter-api/src/routes/reaction.routes.ts` (lines 15-17)

**Description:**
The reaction emoji field accepts any string up to 50 characters. This allows non-emoji strings (HTML, offensive text, extremely long sequences) to be stored as "reactions" and rendered in the UI.

**Code reference:**
```typescript
const toggleReactionSchema = z.object({
  emoji: z.string().min(1).max(50),  // No emoji validation
});
```

**Recommended fix:**
Validate that the emoji field contains only Unicode emoji code points, or restrict to a predefined set of allowed emoji identifiers. A reasonable regex: `/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F]{1,10}$/u`.

---

### BANTER-024 -- Presigned Upload Bypasses Content-Type Enforcement [LOW]

**Affected file:** `apps/banter-api/src/routes/file.routes.ts` (lines 140-200)

**Description:**
The presigned upload endpoint validates `content_type` against the allowlist before generating the presigned URL, but the presigned PUT URL itself does not enforce that the uploaded file matches the declared content type. An attacker can request a presigned URL for `image/png` but upload an executable or HTML file.

**Recommended fix:**
Set a `Content-Type` condition on the presigned URL policy (MinIO/S3 supports this via presigned POST with conditions). Alternatively, validate the actual uploaded file's content type and magic bytes in a post-upload webhook or before serving the file.

---

### BANTER-025 -- No WebSocket Session Expiry Check [LOW]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 76-79)

**Description:**
The WebSocket handler validates the session at connection time but never re-validates it during the connection's lifetime. If a user's session expires or is revoked, their WebSocket connection remains active indefinitely.

**Recommended fix:**
Implement periodic session re-validation (e.g., every 5 minutes) using a heartbeat interval. If the session is expired or revoked, close the WebSocket with an appropriate close code.

---

### BANTER-026 -- Presence Broadcast to Entire Org [LOW]

**Affected file:** `apps/banter-api/src/ws/handler.ts` (lines 84-85)

**Description:**
Every authenticated WebSocket client is auto-subscribed to `banter:org:<orgId>`, which receives org-wide broadcasts. Presence information (online/idle/offline status derived from `last_seen_at`) is available to all org members. In large orgs, this leaks activity patterns of all users to every connected client.

**Recommended fix:**
Scope presence broadcasting to channel-level rooms rather than the org-wide room. Only broadcast a user's presence to channels they are a member of.

---

### BANTER-027 -- Unbounded @mention Processing [LOW]

**Affected file:** `apps/banter-api/src/routes/message.routes.ts` (lines 239-275), `apps/banter-api/src/routes/thread.routes.ts` (lines 270-300)

**Description:**
The `extractMentions()` function is called on message content without limiting how many mentions are processed. A message with thousands of `@` mentions would trigger a large SQL `IN` query and potentially thousands of individual notification dispatches.

**Recommended fix:**
Cap the number of extracted mentions (e.g., 50) and truncate the list with a warning. This prevents both database query amplification and notification spam.

---

### BANTER-028 -- Bookmark Creation Org Isolation Gap [LOW]

**Affected file:** `apps/banter-api/src/routes/bookmark.routes.ts` (lines 56-131)

**Description:**
The `POST /v1/bookmarks` endpoint verifies channel membership before creating a bookmark, but the membership check uses the same "org override" pattern that allows org admins to access public channels. An org admin can bookmark messages in channels they are not members of (by design) but also messages from public channels in their org without explicitly joining. This is a minor data-access expansion beyond explicit membership.

**Recommended fix:**
Evaluate whether the org-admin override is intentional for bookmarks. If not, require explicit channel membership. Document the access model if it is intentional.

---

### BANTER-029 -- DM List Not Paginated [INFORMATIONAL]

**Affected file:** `apps/banter-api/src/routes/dm.routes.ts` (lines 241-274)

**Description:**
The `GET /v1/dm` endpoint returns all DM and group DM channels for the user without pagination. Users with many DMs will receive increasingly large response payloads.

**Recommended fix:**
Add cursor-based pagination consistent with the channel list and message list endpoints.

---

### BANTER-030 -- Channel Browse Not Paginated [INFORMATIONAL]

**Affected file:** `apps/banter-api/src/routes/channel.routes.ts` (lines 404-425)

**Description:**
The `GET /v1/channels/browse` endpoint returns all public channels for the org without pagination. Orgs with many channels will receive large response payloads.

**Recommended fix:**
Add cursor-based or offset-based pagination with a default limit.

---

## Appendix: Methodology Notes

- **Deduplication:** 5 findings were reported by both agents and consolidated into single entries (BANTER-001, BANTER-002, BANTER-003, BANTER-004, BANTER-005/006/007).
- **Severity ratings** follow a standard scale: Critical (immediate exploitation, high impact), High (exploitation likely, significant impact), Medium (exploitation possible, moderate impact), Low (exploitation unlikely or low impact), Informational (best-practice improvement).
- **File paths** are relative to the repository root (`D:\Documents\GitHub\BigBlueBam\`).
- All line numbers reference commit `8683337` and may shift as the codebase evolves.
