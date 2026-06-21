# Strategy: Book booking pages ⇄ Bond CRM integration

_2026-06-13. Status: proposal for review. Source ToDo: "Book: Booking pages… awaiting integration with Bond since booking meetings can be closely connected with CRM. We should close this loop."_

## TL;DR — the premise is stale; the integration is half-built and silently broken

The "Booking pages are coming soon, awaiting Bond integration" framing is out of date. The booking-page **list, editor, and public booking flow already ship and work**, and the public booking handler **already tries to create a Bond contact on every booking** — but that attempt **fails 100% of the time and the failure is swallowed**. So the real task is not "build the integration," it's **"fix and finish a half-wired integration that shipped behind a misleading banner."**

The single user-facing artifact that says "coming soon" is one amber banner in `apps/book/src/pages/booking-page-list.tsx:37-43`:
> "Feature under development — Booking pages are coming soon. We're integrating with Bond CRM to support lead capture and meeting scheduling."

Removing/replacing that banner is part of shipping; it currently over-promises and under-delivers at the same time.

## Current state (grounded)

**Frontend — built, not stubbed** (`apps/book/src`):
- `pages/booking-page-list.tsx` — working CRUD list (title, `/meet/{slug}`, duration, active/disabled, edit/delete). The only "under construction" artifact is the banner above it.
- `pages/booking-page-editor.tsx` — working editor, but it does **not** expose the Bond/Bam fields that already exist in the schema/API: `auto_create_bond_contact`, `auto_create_bam_task`, `bam_project_id` (plus `max_advance_days`, `min_notice_hours`, `confirmation_message`, `redirect_url`). So a user can't see or toggle the Bond sync — it's hardcoded on by the DB default `auto_create_bond_contact = true`.
- `pages/meet.tsx` — the public `/meet/:slug` page captures **name, email, notes, start time**. No company, phone, custom questions, or multi-attendee.

**Backend — built, with one fatal cross-app call** (`apps/book-api/src`):
- Schema already anticipates this work: `book_booking_pages` carries `auto_create_bond_contact` (default true), `auto_create_bam_task`, `bam_project_id`.
- `routes/public-booking.routes.ts` `POST /meet/:slug/book` does three things on a booking: (1) inserts the `book_events` row (transactional, overlap-checked) ✅; (2) fires a Bolt event `('booking.created', source 'book')` with an enriched payload ✅; (3) **attempts a direct Bond contact create — dead on arrival** (lines ~94-111).

### Why the Bond call is dead on arrival (decisive)
1. **Wrong/untyped env var.** It reads `BOND_API_INTERNAL_URL` via an untyped cast; that var is **not in book-api's env schema** (`apps/book-api/src/env.ts`) and **not set in book-api's docker-compose block** — so it's `undefined`, falling back to a hardcoded `http://bond-api:4009`. The host is coincidentally right; the typing is a lie.
2. **Wrong auth — the fatal one.** Bond's `POST /v1/contacts` requires `requireAuth + requireCan('bond.contact.create') + requireScope('read_write')`. The book call sends only an `x-internal-secret` header and **no bearer/cookie**. Worse, **bond-api has no internal-secret ingress at all** — it only ever *sends* `x-internal-secret`, never accepts it as a credential. So the call 401s.
3. The failure is swallowed by `.catch(() => {})`, so **no contact is ever created and nothing is logged.** The Bam-task call (lines ~113-132) is structurally broken the same way.

Net: the integration looks implemented in a code read, ships with a reassuring banner, and does nothing.

## What *should* happen on a public booking

Identifying info available at booking time: **guest email** (the natural match key), **guest name** (split to first/last, as Book already does), **start time**, **notes**. No company/phone/deal info is captured by the public form, so deal/company association can't be derived from form data alone.

Desired Bond outcome per booking:
1. **Upsert the booker as a contact** by email — idempotent so repeat bookers don't duplicate. Use Bond's `POST /v1/contacts/upsert` (natural key `(org, lower(email))`, returns `{data, created}`), with `lifecycle_stage: 'lead'`, `lead_source: 'booking_page'`. **Today Book (mis)calls the non-idempotent `/contacts` create — switch to upsert regardless of which option below is chosen.**
2. **Log a `'meeting'` activity** against that contact (`POST /v1/activities`, `activity_type` enum already includes `meeting`): `subject` = page title / "Meeting with {host}", `body` = notes, `performed_at` = booking start, `metadata` = `{ booking_page_id, book_event_id, duration_minutes, meeting_url }`. **This is the currently-missing half** — even the original intent only created a contact, never logged the meeting, so the CRM timeline would show a lead with no meeting.
3. **(Optional) Link** `book_event ⇄ bond_contact` via `entity_links` so each side renders the other (requires extending the Wave-2 writable allowlist — `book.event` isn't currently writable there).
4. **(Phase 2) Deal/company** association — net-new: needs a `bond_pipeline_id`/`bond_deal_id` on `book_booking_pages` and a company match (e.g. email-domain → `bond_companies.domain`). Out of scope for closing the loop.

## Options (with tradeoffs)

### Option A — Direct internal API call (Book → Bond), fix-in-place
Add `BOND_API_INTERNAL_URL` to book-api's env schema + compose; add an **`internal.routes.ts` to bond-api** (copy book-api's own existing template) exposing `POST /v1/internal/contacts/upsert` + `POST /v1/internal/activities` guarded by `INTERNAL_SERVICE_SECRET` (timing-safe, fail-closed if unset); have the booking handler call those two with the secret header and an explicit `org_id` (the booking knows `event.organization_id`).
- **Pros:** synchronous, deterministic, matches the existing bureau↔book internal-route precedent, no admin config, works even if Bolt/worker is down. Fixes the actual root cause (anonymous bookings have no auth identity).
- **Cons:** new internal surface to build + secure on Bond; Book learns Bond's address; two calls to sequence (upsert → log activity with the returned `contact_id`).

### Option B — Bolt-event-driven (loosest coupling)
Lean on the already-emitted `booking.created` Bolt event; ship a **seeded/default Bolt automation** that upserts the contact + logs the meeting via the existing `bond_create_contact` / `bond_log_activity` Bolt actions (already registered; the worker→MCP→service-account path already solves the auth problem that Book's raw call trips over).
- **Pros:** zero new internal surface; admin-tunable; the event + actions already exist; auth already solved.
- **Cons:** async/eventually-consistent; depends on worker + MCP + the automation existing; "upsert then log activity with the *new* contact_id" is a two-step chain that current Bolt automations may not thread cleanly (needs verification — see open Q); harder for a user to reason about than always-on behavior.

### Option C — Book calls MCP `/tools/call` directly
Booking handler POSTs to `mcp-server /tools/call` with `bond_upsert_contact` then `bond_log_activity`, using `X-Internal-Secret` + `X-Org-Id` (MCP mints a service-account bearer, giving a valid Bond identity).
- **Pros:** reuses the one internal surface that already mints a valid Bond identity — no new Bond route, no auth gap; synchronous; gets idempotency + fuzzy resolution for free.
- **Cons:** couples Book to MCP; requires `MCP_INTERNAL_API_TOKEN` configured for book-api's calls (now wired on prod per the internal-routing work, but a new dependency for Book); two inline tool calls in the request path (mitigate fire-and-forget).

## Recommendation

**Make the core deterministic (Option A or C) and keep the `booking.created` Bolt event as the open extension point.** "The contact and the meeting reliably appear in the CRM" is table-stakes, not an optional automation — so it shouldn't depend on an admin having built a Bolt rule (Option B alone). Between A and C:
- **Option C is the smaller, lower-risk change** — it reuses MCP's existing service-account auth, so it needs **no new Bond route** and no new auth surface, and inherits idempotency + the activity-logging tool. The main cost is a Book→MCP dependency + ensuring `MCP_INTERNAL_API_TOKEN` is set for book-api.
- **Option A is the more "honest" architecture** (Book talks to Bond, not through MCP) but requires building + securing a new internal ingress on Bond, which Bond conspicuously lacks today.

**Proposed: Option C for v1** (fastest correct fix, least new surface), then leave `booking.created` as the documented hook for admins who want extra automations (Banter ping, deal creation, etc.). Regardless of option, **switch the contact write from create to upsert and add the missing meeting-activity log.**

## Open design questions (resolve before/while implementing)

1. **Sync vs. event:** deterministic inline (A/C) vs. admin-configured Bolt (B). _Recommend A/C for the core._
2. **Org identity for anonymous bookings:** the public request has no session; pass `event.organization_id` explicitly and have the receiving write trust it via an internal-secret/service-account surface.
3. **Owner attribution:** a booking has no acting user — use the page **owner** (`book_booking_pages.owner_user_id`) as the contact `owner_id` and the activity `performed_by`?
4. **Create → upsert:** switch Book off `/contacts` create to `/contacts/upsert` — unambiguous, do it regardless of option.
5. **Surface the per-page toggle:** `auto_create_bond_contact` / `auto_create_bam_task` / `bam_project_id` exist in schema + API but aren't in the editor UI. Decide always-on vs. per-page (schema assumes per-page, default on) and expose it.
6. **The missing activity log:** confirm logging a `meeting` activity is in scope (recommended).
7. **Deal/company:** Phase 2 only; needs new schema + a company-match heuristic.
8. **entity_links:** extend the writable allowlist to make `book.event ⇄ bond.contact` first-class, or is `activity.metadata.book_event_id` a sufficient back-reference for v1?
9. **The banner:** remove the "coming soon / integrating with Bond" banner as part of shipping; replace with nothing (the feature is live) or a brief "synced to Bond CRM" note.
10. **Idempotency on retries/double-submit:** bookings are rate-limited (10/min) but not idempotent. `/contacts/upsert` is safe on retry, but a duplicate `meeting` activity could be logged — dedupe on `book_event_id` (in metadata) or use the platform `ingest_fingerprint` primitive.

## Suggested phasing

- **Phase 1 (close the loop):** fix the broken on-booking path (Option C), upsert contact + log meeting activity, pass org_id explicitly, dedupe on `book_event_id`. Remove the banner. Surface the `auto_create_bond_contact` toggle in the editor.
- **Phase 2 (richer CRM):** entity_links `book.event ⇄ bond.contact`; capture company (email-domain match); optional deal creation/attachment via a new `bond_pipeline_id` on the booking page.
- **Phase 3 (extensibility):** document `booking.created` as the public automation hook; ship one optional seeded Bolt automation as an example (notify a Banter channel on booking).

## Key files (for whoever implements)

- Broken on-booking call: `apps/book-api/src/routes/public-booking.routes.ts:84-132`
- Missing env: `apps/book-api/src/env.ts`; docker-compose book-api block (no `BOND_API_INTERNAL_URL`)
- Banner: `apps/book/src/pages/booking-page-list.tsx:37-43`; editor missing toggles: `apps/book/src/pages/booking-page-editor.tsx`
- Bond targets: `apps/bond-api/src/routes/contacts.routes.ts` (`/contacts/upsert`), `apps/bond-api/src/routes/activities.routes.ts` (`/activities`); services `contact-upsert.service.ts`, `activity.service.ts`
- Reusable internal-route template (for Option A): `apps/book-api/src/routes/internal.routes.ts` (Bond has no equivalent yet)
- MCP surface (Option C): `apps/mcp-server/src/routes/tools-call.ts`; Bond MCP tools `apps/mcp-server/src/tools/bond-tools.ts` (`bond_upsert_contact`, `bond_log_activity`)
- Bolt hook (Option B / Phase 3): event `booking.created` in `apps/bolt-api/src/services/event-catalog.ts`; action registry `apps/bolt-api/src/services/automation.service.ts`; executor `apps/worker/src/jobs/bolt-execute.job.ts`
- entity_links allowlist (Phase 2): `apps/api/src/services/entity-links.service.ts`

> Note for the batch: the broken on-booking Bond call is a real, current bug (silent 401 on every booking), not just a strategy item. It is recorded in `docs/functionality-audits/2026-06-13-todo-batch.md` as a follow-up fix so it isn't lost — implementing Phase 1 above closes it.
