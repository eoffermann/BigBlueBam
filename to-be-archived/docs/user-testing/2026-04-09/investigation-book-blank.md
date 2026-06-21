# Investigation: Book and Blank user-testing issues (2026-04-09)

Research-only document. No code changes were made. Each section gives the root cause, evidence (file paths and line refs), and a recommended fix.

---

## Book Issue 1 — Cannot create an event because there are no calendars and no way to make one

### Root cause

Three layered defects combine to produce a hard dead-end:

1. **No calendar-management UI exists in the Book SPA at all.** `apps/book/src/app.tsx` (lines 16-66) defines every route in the app and there is no `calendars` page. The frontend hooks expose `useCreateCalendar` (`apps/book/src/hooks/use-calendars.ts:38`) but nothing in the UI ever calls it.
2. **No calendar is auto-provisioned on signup, on first org membership, or on first visit to Book.** A grep across `apps/book-api/src` for `createCalendar`, `default.*[Cc]alendar`, and `is_default` shows that `createCalendar` is only invoked from the route handler in `apps/book-api/src/routes/calendars.routes.ts:48`. There is no bootstrap path. `apps/book-api/src/services/calendar.service.ts:78-98` creates calendars but **never sets `is_default: true`** — the column defaults to `false` (`apps/book-api/src/db/schema/book-calendars.ts:25`).
3. **The event-form requires a non-empty `calendar_id` and disables Save when there isn't one.** `apps/book/src/pages/event-form.tsx:103` adds `calendarId` to the validation errors map if blank, and `canSubmit` is false (line 110). The select on lines 200-217 only renders calendars returned from `useCalendars()`, so when the list is empty the user sees "Select a calendar" with zero options and is permanently blocked.

### Evidence from the database

```
docker exec bigbluebam-postgres-1 psql -U bigbluebam -c "SELECT COUNT(*) FROM book_calendars;"
 count
-------
     0
```

Zero calendars in the seeded test database. This matches the user-testing report exactly.

### Recommended fix

Two complementary changes — pick whichever cadence the team prefers, but ideally do both:

1. **Auto-create a default personal calendar on first read.** In `apps/book-api/src/services/calendar.service.ts::listCalendars`, after running the select, if zero rows are returned for `(organization_id, owner_user_id)` create one inline:

   ```ts
   // pseudocode
   if (rows.length === 0) {
     const [created] = await db.insert(bookCalendars).values({
       organization_id: filters.organization_id,
       owner_user_id: filters.user_id,
       name: 'My Calendar',
       color: '#3b82f6',
       calendar_type: 'personal',
       is_default: true,
       timezone: 'UTC',
     }).returning();
     rows.push(created!);
   }
   ```

   This is idempotent (subsequent loads find the row) and zero-friction. Note `book_calendars` already has the `is_default` boolean (`book-calendars.ts:25`) — no migration needed.

2. **Add a Calendars management page to the Book SPA.** Add `'/settings/calendars'` to the route table in `apps/book/src/app.tsx`, link it from `BookLayout`, and create `apps/book/src/pages/calendars.tsx` that lists calendars from `useCalendars()` and lets the user create, rename, recolor, set default, and delete calendars via the existing hooks (`useCreateCalendar`, `useUpdateCalendar`, `useDeleteCalendar`). The API endpoints already exist (`apps/book-api/src/routes/calendars.routes.ts:42-80`).

3. **Optional polish:** in `event-form.tsx`, when `calendars.length === 0` and not loading, render an empty-state with a "Create your first calendar" button that opens an inline creation modal — so users discover calendar creation from the place they hit the wall.

---

## Book Issue 2 — No way to add attendees from system users

### Root cause

The **API already supports attendees**, including user-id-keyed attendees, but the **frontend form never exposes any attendee UI at all**.

- API: `apps/book-api/src/routes/events.routes.ts:23-32` accepts an `attendees` array on POST `/events`, where each attendee is `{ user_id?, email, name?, is_organizer? }`. The `book_event_attendees` table exists in the schema (`apps/book-api/src/db/schema/book-event-attendees.ts`).
- Frontend: `apps/book/src/pages/event-form.tsx` has form state for title, description, calendar, start/end, allDay, location, recurrence, color, reminderMinutes, visibility — and **nothing for attendees**. The payload submitted on line 116-126 omits the field entirely. There is no attendee picker, autocomplete, or chip list anywhere in the file.

The PATCH route's `updateEventSchema` (`events.routes.ts:35-46`) does not currently support modifying attendees post-create either — only the create path does. Attendees added during create flow via POST are persisted by `eventService.createEvent`, but there is no endpoint to add/remove an attendee on an existing event.

### Recommended fix

1. **Add an org-user search endpoint or reuse one.** The Book API needs a way to look up users in the active org by name/email prefix for the picker. Two options:
   - Easiest: have Book call the existing Bam API user search via the auth-shared layer. Check `apps/book-api/src/plugins/auth.ts` — the `users` table is already imported into `bbb-refs.ts` so a local `GET /v1/org-users?q=...` endpoint in `book-api` is trivial (3-5 lines: a select on `users` joined to `organization_memberships` filtered by `request.user!.org_id` and an `ILIKE` on `display_name` / `email`).
2. **Add an `AttendeePicker` component** in `apps/book/src/components/` that wraps a debounced query to that endpoint, displays search results, and emits chips. Persist the list as `Array<{ user_id?: string; email: string; name?: string }>`.
3. **Wire it into `event-form.tsx`** between the Description and Location sections. Add an `attendees` state array, render the picker, and include `attendees: attendees` in the create payload (line 116-126). For external attendees the user should be able to type a raw email and have it added as a no-`user_id` row.
4. **Add attendee mutations on PATCH events.** Extend `events.routes.ts::updateEventSchema` with an optional `attendees` array, and add `addAttendee` / `removeAttendee` helpers in `event.service.ts`, OR add `POST /events/:id/attendees` and `DELETE /events/:id/attendees/:attendeeId`. Either pattern is fine; the latter aligns better with REST and avoids needing to diff arrays.
5. **Send invite emails** via the existing worker email queue (`apps/worker/src/handlers/email.ts`) when an attendee is added — out of scope for the immediate fix, but worth noting in the ticket.

---

## Book Issue 3 — Video calls via UUID-enhanced URL using same LiveKit framework as Banter

### How Banter uses LiveKit today

Banter has a complete LiveKit integration. The key files:

- **`apps/banter-api/src/services/livekit-token.ts`** — exports `generateLiveKitToken({ participantIdentity, participantName, roomName, grants?, ttlSeconds? })` which builds a JOSE-signed JWT with the standard LiveKit `video` grant claims (`roomJoin`, `canPublish`, `canSubscribe`, `canPublishData`). Reads `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from `env.ts`. Also exports `buildRoomName(orgId, channelId, callId)` which currently builds names of the form `banter_${orgId}_${channelId}_${callId}`.
- **`apps/banter-api/src/routes/call.routes.ts`** — the full call lifecycle. Notable endpoints:
  - `POST /v1/channels/:id/calls` (line 33) — creates a `banter_calls` row with a freshly minted `livekit_room_name`, inserts a `banter_call_participants` host row, generates a token, and returns `{ call, token, livekit_url: env.LIVEKIT_WS_URL, existing }`.
  - `POST /v1/calls/:id/join` (line 329) — auth-checks channel membership, inserts a participant row, returns a fresh token + livekit_url.
  - `POST /v1/calls/:id/leave` (line 425), `POST /v1/calls/:id/end` (line 503), `PATCH /v1/calls/:id/media-state` (line 987) — round out the lifecycle.
  - WebSocket broadcasts via `broadcastToChannel(...)` push call lifecycle events to channel members.
- **Storage:** `banter_calls` (`apps/banter-api/src/db/schema/calls.ts`) holds `livekit_room_name`, `started_by`, `type` (voice|video|huddle), `status`, `peak_participant_count`, `recording_enabled`, etc. Recording is wired through `services/recording.ts` (LiveKit Egress).
- **Client connects** by handing the token and `livekit_url` to the `livekit-client` SDK in the Banter frontend.

### What Book needs

The user wants any external person (no Bam account required) to be able to join a Book event's video call by clicking a URL with a UUID in it. That's a public room with a UUID slug, and an unauthenticated token-mint endpoint.

### Recommended pattern

1. **Schema:** add two columns to `book_events` (new migration in `infra/postgres/migrations/`):
   ```sql
   ALTER TABLE book_events
     ADD COLUMN IF NOT EXISTS video_call_enabled boolean NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS video_call_room_id uuid;  -- nullable; set when enabled
   ```
   Mirror in `apps/book-api/src/db/schema/book-events.ts`. The existing `meeting_url` column (line 29) can hold the human-shareable URL.

2. **Helper: `buildBookRoomName`** — copy the LiveKit token helper into Book. Either:
   - **Simplest:** vendor `livekit-token.ts` into `apps/book-api/src/services/livekit-token.ts` (it's 80 lines and has no Banter-specific dependencies). Add `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` to `apps/book-api/src/env.ts`.
   - **Cleaner:** lift it into `packages/shared/src/livekit/` and import from both apps. Worth doing since Board likely also wants this.
   Use a room name like `book_${orgId}_${eventId}_${video_call_room_id}` to avoid collisions.

3. **Endpoint: `POST /v1/events/:id/video-call/token`** — public, unauthenticated, takes `{ display_name: string; participant_id?: string }`. Looks up the event by ID, verifies `video_call_enabled = true`, generates a participant identity (`guest_${randomUUID()}` if anonymous, else the bbam user id if a session cookie is present), mints a token, and returns `{ token, livekit_url, room_name, event_title }`. Rate-limit aggressively (e.g. 30/min/IP) since it's unauthed.

4. **Sharable URL pattern:** `/book/events/:eventId/join` is the natural shape. Add a public route in the Book SPA — `apps/book/src/pages/event-join.tsx` — that does NOT require auth, fetches the token from the endpoint above, and embeds the LiveKit room. The route should be added to `app.tsx::parseRoute` and the auth gate (line 114-126) should be skipped for `/events/:id/join` paths. Nginx already proxies `/book/api/` to `book-api:4004`, so no proxy work is needed.

5. **Toggle in event-form:** add a checkbox "Enable video call" to `event-form.tsx`. When checked on create, the API generates a `video_call_room_id` and stamps `meeting_url` to `https://${HOST}/book/events/${eventId}/join`. Display the URL in `event-detail.tsx` with a copy-to-clipboard button.

6. **No additional infra needed.** LiveKit SFU is already running (`infra/livekit/livekit.yaml`, exposed in compose). The same `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` work for any service that mints valid tokens.

---

## Book Issue 4 — Events should reference Banter channel discussions or Board sessions

### Current state

`book_events` already has a primitive cross-product reference mechanism:

- `book-events.ts:39-40`: `linked_entity_type` (`varchar(20)`) and `linked_entity_id` (`uuid`).
- `events.routes.ts:21-22`: the create schema accepts `linked_entity_type: enum(['bam_task', 'bond_deal', 'helpdesk_ticket'])` and `linked_entity_id: uuid`.

But this is **single-link only**, the enum **does not include Banter or Board**, and the field is **not exposed in the event-form UI**.

### Recommended fix

The user wants multiple, typed cross-product references — best modeled as a JSONB array (or a join table; JSONB is simpler given the cross-product, no-foreign-key nature).

1. **Schema:** add a JSONB column to `book_events`:
   ```sql
   ALTER TABLE book_events
     ADD COLUMN IF NOT EXISTS related_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
   ```
   Shape:
   ```ts
   type RelatedRef =
     | { type: 'banter_channel'; id: string; label?: string }
     | { type: 'banter_thread'; channel_id: string; thread_root_id: string; label?: string }
     | { type: 'board_session'; board_id: string; label?: string }
     | { type: 'bam_task'; project_id: string; task_id: string; label?: string }
     | { type: 'brief_doc'; doc_id: string; label?: string }
     | { type: 'bond_deal'; deal_id: string; label?: string };
   ```
   Use a lightweight JSON Schema check via a Postgres `CHECK` (or just validate in Zod).

2. **Deprecate the old single-link fields** over time — leave `linked_entity_type`/`linked_entity_id` in place for backward compat but treat them as legacy in new UI. Migration can backfill them into `related_refs[0]`.

3. **API:** extend `createEventSchema` and `updateEventSchema` in `events.routes.ts` with `related_refs: z.array(relatedRefSchema).optional()`. The corresponding service methods need to persist them.

4. **UI: Related Items section in event-form.** Below Description, render a "Related" section with an "Add reference" button. Picker is a single combobox: pick a type (Banter Channel, Board, etc.), then a downstream picker that calls into the relevant API to search. For Banter, hit `GET /banter/api/v1/channels?q=...` (already exists). For Board, hit `/board/api/v1/boards?q=...`. Selected refs show as chips with the right product icon and a link out to the deep-link URL when clicked.

5. **Bidirectional discovery (out of scope but worth noting):** Banter channels could surface "Scheduled events" by querying `GET /book/api/v1/events?related_ref_type=banter_channel&related_ref_id=:id`. Add that filter to the events list query when implementing.

---

## Book Issue 5 — "Booking Pages" needs an "under development" notification banner

### Where to add it

`apps/book/src/pages/booking-page-list.tsx`. The page header is at lines 22-34. Insert a notification banner immediately after the header div (i.e., as the first child of the `space-y-6` container, before the list/empty-state block at line 36).

### Recommended snippet

A non-dismissible amber banner above the existing content. Suggested markup that matches the page's existing Tailwind palette:

```tsx
<div className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-4 flex gap-3">
  <Construction className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
  <div>
    <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
      This feature is under development
    </div>
    <div className="text-xs text-amber-800/80 dark:text-amber-200/80 mt-1">
      Booking Pages will eventually integrate with Bond contacts and deals to power
      external scheduling links. The interface below is a preview and may change.
    </div>
  </div>
</div>
```

Add `Construction` to the existing `lucide-react` import on line 1. No backend or routing changes needed. The user's instructions explicitly say to leave the rest of the page "untouched except for the notification box."

---

## Blank Issue — Form publish flow is unclear (visibility, expiration, sharable URL)

### Current state, mapped to the user's request

| User wants | Today's state |
|---|---|
| Public form (no login) | Partial — `form_type` enum is `'public' \| 'internal' \| 'embedded'` (`blank-forms.ts:25`) and `requires_login` boolean (line 26) exists, but the publish flow does not gate on it and the public renderer does not check it. |
| Private form, restricted to org members | **Missing.** No org-membership check on `getFormBySlug`. `apps/blank-api/src/services/form.service.ts:184-189` only filters by `slug` and `status='published'` — anyone with the slug can fetch any published form. |
| Private form, restricted to project members | **Missing.** `project_id` exists on `blank_forms` (`blank-forms.ts:21`) but is not used anywhere in the public route to enforce access. |
| Optional expiration date | **Missing.** No `expires_at` column on `blank_forms`. |
| Sharable URL | **Exists, but hidden.** Public route is `GET /forms/:slug` proxied at `http://HOST/forms/:slug` (`infra/nginx/nginx.conf:284-285`). Built into `apps/blank-api/src/routes/public.routes.ts:20-34`. The URL is **never displayed in the Blank UI** after publishing. |
| Confirmation that form is published and where | **Missing.** `form-builder.tsx:528-532` has a Publish button. After clicking, no toast, no URL surfaced, no link to view, no QR code. The user has no idea where the form lives. |

Additional gaps:

- The publish endpoint (`forms.routes.ts:167-181`) requires `admin` role and inserts a `published_at` timestamp, but never validates that `requires_login`/`form_type` are coherent. A form with `form_type='public'` and `requires_login=true` is currently allowed but nonsensical.
- `getFormBySlug` does not enforce expiry or `accept_responses=false` for fetching the definition (only the renderer checks `accept_responses`).
- There is no UI for `requires_login`, `form_type`, or `project_id` in the form builder — only in the settings page (`form-settings.tsx:39-67`), and even there only `form_type` and `accept_responses` show; `requires_login` and `project_id` are not editable.

### Recommended fix

#### 1. Schema additions (one new migration)

```sql
ALTER TABLE blank_forms
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS visibility varchar(20) NOT NULL DEFAULT 'public';
-- visibility ∈ ('public', 'org', 'project')
ALTER TABLE blank_forms
  ADD CONSTRAINT IF NOT EXISTS blank_forms_visibility_chk
  CHECK (visibility IN ('public', 'org', 'project'));
CREATE INDEX IF NOT EXISTS idx_blank_forms_expires_at ON blank_forms(expires_at) WHERE expires_at IS NOT NULL;
```

Mirror in `apps/blank-api/src/db/schema/blank-forms.ts`. Note: `visibility` semantically replaces the loosely-defined `form_type` field; you can either deprecate `form_type` or keep it as a presentation hint and use `visibility` strictly for access control.

#### 2. Backend access control

Update `getFormBySlug` (`form.service.ts:184`) to take an optional caller context `{ user_id?, org_id?, project_ids? }`. When `visibility = 'org'`, require `org_id === form.organization_id`. When `visibility = 'project'`, require `form.project_id IS NOT NULL && project_ids.includes(form.project_id)`. When `expires_at IS NOT NULL && expires_at < now()`, throw `notFound`.

The public route (`public.routes.ts:20`) needs to read the session cookie when present and pass org/project context to the service. For `visibility != 'public'`, return a 401/403 with a "log in to access this form" page if no session.

#### 3. Update `forms.routes.ts` Zod schemas

Add `visibility`, `expires_at`, and `project_id` to both `createFormSchema` (line 42) and `updateFormSchema` (line 56). The `publishForm` service (line 334) should additionally validate that `visibility='project'` implies `project_id IS NOT NULL`.

#### 4. UI changes in `apps/blank/src/pages/form-builder.tsx` and `form-settings.tsx`

- **Form-settings Access section** (`form-settings.tsx:38-67`): replace the `form_type` select with a `visibility` select (Public / Org members / Project members). When Project is chosen, show a project picker (reuse Bam's project list endpoint). Add an `expires_at` datetime input.
- **Publish dialog/flow:** when the user clicks Publish (`form-builder.tsx:528`), instead of just toggling state, open a modal that:
  1. Lets them confirm visibility, project, and expiration one last time.
  2. After publish, displays the public URL (`https://${HOST}/forms/${slug}`) with a copy button, a "Open in new tab" link, and (nice-to-have) a downloadable QR code.
  3. Adds a persistent "Share" button on the form-builder header for already-published forms that re-opens this dialog.
- **Form-list page:** add a small URL/copy icon next to each published form so the user can grab the link without re-entering the editor.

#### 5. Worker job: auto-close expired forms

Add a periodic job in `apps/worker/src/handlers/` (or extend an existing scheduled handler) that runs `UPDATE blank_forms SET accept_responses=false WHERE expires_at < now() AND accept_responses = true`. Cheap and idempotent.

#### 6. Backwards-compat note

Existing forms with `form_type='public'` should be migrated to `visibility='public'` in the same migration:

```sql
UPDATE blank_forms SET visibility = 'public' WHERE visibility IS NULL;
```

(Idempotent and safe because of the column default.)

---

## Quick reference: key file paths

| Concern | File |
|---|---|
| Book event form | `D:\Documents\GitHub\BigBlueBam\apps\book\src\pages\event-form.tsx` |
| Book routes (frontend) | `D:\Documents\GitHub\BigBlueBam\apps\book\src\app.tsx` |
| Book calendars hook | `D:\Documents\GitHub\BigBlueBam\apps\book\src\hooks\use-calendars.ts` |
| Book calendars API route | `D:\Documents\GitHub\BigBlueBam\apps\book-api\src\routes\calendars.routes.ts` |
| Book calendar service | `D:\Documents\GitHub\BigBlueBam\apps\book-api\src\services\calendar.service.ts` |
| Book events API route | `D:\Documents\GitHub\BigBlueBam\apps\book-api\src\routes\events.routes.ts` |
| Book events schema | `D:\Documents\GitHub\BigBlueBam\apps\book-api\src\db\schema\book-events.ts` |
| Book booking-pages list | `D:\Documents\GitHub\BigBlueBam\apps\book\src\pages\booking-page-list.tsx` |
| Banter LiveKit token mint | `D:\Documents\GitHub\BigBlueBam\apps\banter-api\src\services\livekit-token.ts` |
| Banter call lifecycle routes | `D:\Documents\GitHub\BigBlueBam\apps\banter-api\src\routes\call.routes.ts` |
| Blank forms schema | `D:\Documents\GitHub\BigBlueBam\apps\blank-api\src\db\schema\blank-forms.ts` |
| Blank forms routes | `D:\Documents\GitHub\BigBlueBam\apps\blank-api\src\routes\forms.routes.ts` |
| Blank public form route | `D:\Documents\GitHub\BigBlueBam\apps\blank-api\src\routes\public.routes.ts` |
| Blank form service (publish, getBySlug) | `D:\Documents\GitHub\BigBlueBam\apps\blank-api\src\services\form.service.ts` |
| Blank form-builder (publish button) | `D:\Documents\GitHub\BigBlueBam\apps\blank\src\pages\form-builder.tsx` |
| Blank form-settings (Access controls) | `D:\Documents\GitHub\BigBlueBam\apps\blank\src\pages\form-settings.tsx` |
| Nginx routing for /forms/:slug | `D:\Documents\GitHub\BigBlueBam\infra\nginx\nginx.conf` (line ~284) |
