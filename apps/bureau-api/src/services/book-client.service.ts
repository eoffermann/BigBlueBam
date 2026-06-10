/**
 * Internal HTTP client for the Book service (workstream 4 — Agent A).
 *
 * Bureau bookings are the canonical "this room is reserved at this time"
 * record on the floorplan side. But the team's actual calendar lives in
 * Book — Book is where invitations get RSVPs, where iCal feeds source
 * their rows, where external Google/Microsoft sync flows in and out, and
 * where the events surface in the user's "what's on my calendar today"
 * timeline.
 *
 * Wave 0.3 wired the bureau_bookings row but left book_event_id as a
 * locally-minted UUID. This module is the round-trip:
 *
 *   - createBookEvent posts to book-api's internal route, gets back the
 *     real Book event id (and an in-app meeting URL pointing at the
 *     Bureau room join page), and the bureau row is anchored to it.
 *   - cancelBookEvent flips the Book event status to cancelled when a
 *     bureau booking is soft-cancelled.
 *   - getBookEvent is a thin lookup so other Bureau code can show the
 *     Book event's attendee list, RSVPs, etc. without re-deriving them.
 *
 * Auth: X-Internal-Service-Secret header, timing-safe compared on the
 * book-api side. This is the same posture every other internal
 * service-to-service call uses in this monorepo (see
 * apps/bureau-api/src/routes/internal.routes.ts for the inbound mirror).
 *
 * Failure posture: callers (e.g. bookings.routes.ts) should catch
 * BookClientError and decide whether the operation can degrade to a
 * local-only booking. For room reservations the answer is yes — Book
 * being briefly unreachable should never stop a member from grabbing a
 * conference room — so the route handler falls back to a self-minted
 * UUID and logs a warning rather than failing the user-facing POST.
 */

import { env } from '../env.js';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface CreateBookEventArgs {
  /** Organization id (Book scopes events per-org). */
  orgId: string;
  /** Acting user — becomes Book's created_by AND the organizer attendee. */
  organizerId: string;
  /** Bureau room id — used to build the deep-link meeting_url. */
  roomId: string;
  /** Event title (mirrors the bureau booking title). */
  title: string;
  /** Window start (ISO-8601 / RFC 3339 with timezone offset). */
  startsAt: string;
  /** Window end (ISO-8601 / RFC 3339 with timezone offset). */
  endsAt: string;
}

export interface CreateBookEventResult {
  bookEventId: string;
  meetingUrl?: string | null;
}

export interface BookEventPayload {
  id: string;
  title: string;
  status: string;
  start_at: string;
  end_at: string;
  meeting_url?: string | null;
  organization_id: string;
  calendar_id: string;
}

/**
 * Typed transport error so callers can distinguish "Book said no" (we
 * tried, the call hit Book, Book rejected the body) from "Book is
 * unreachable" (network, DNS, timeout) without re-parsing error shape.
 *
 * `kind` is the cheap discriminator; `status` is the HTTP status when
 * we got one (undefined for transport-level failures).
 */
export class BookClientError extends Error {
  constructor(
    message: string,
    public readonly kind: 'transport' | 'http',
    public readonly status?: number,
    public readonly bodyText?: string,
  ) {
    super(message);
    this.name = 'BookClientError';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

/** Default 5s — internal hop; this should never take longer than that. */
const DEFAULT_TIMEOUT_MS = 5_000;

function baseUrl(): string {
  return env.BOOK_INTERNAL_URL.replace(/\/$/, '');
}

function requireSecret(): string {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    throw new BookClientError(
      'INTERNAL_SERVICE_SECRET is not configured — refusing to call book-api',
      'transport',
    );
  }
  return secret;
}

async function postJson(
  path: string,
  body: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown; text: string }> {
  const secret = requireSecret();
  const url = `${baseUrl()}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Secret': secret,
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown fetch failure';
    throw new BookClientError(`POST ${url} failed: ${message}`, 'transport');
  }

  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response (likely an HTML proxy error page). Keep the
      // raw text so the caller can log it; do not throw yet so the
      // status-based branch below has the chance to surface the http
      // error in its preferred shape.
      json = null;
    }
  }
  return { status: res.status, json, text };
}

async function getJson(
  path: string,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown; text: string }> {
  const secret = requireSecret();
  const url = `${baseUrl()}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Internal-Service-Secret': secret },
      signal,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown fetch failure';
    throw new BookClientError(`GET ${url} failed: ${message}`, 'transport');
  }

  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text };
}

function withTimeout(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms).unref?.();
  return ctrl.signal;
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Create a Book event mirroring a Bureau booking. Returns the Book event
 * id (to write back into bureau_bookings.book_event_id) and the in-app
 * meeting URL Book minted for the bureau room.
 *
 * Throws BookClientError on transport failure or non-2xx response so
 * the route handler can decide whether to fall back to a local UUID.
 */
export async function createBookEvent(
  args: CreateBookEventArgs,
): Promise<CreateBookEventResult> {
  const { status, json, text } = await postJson(
    '/v1/internal/events',
    {
      org_id: args.orgId,
      organizer_id: args.organizerId,
      room_id: args.roomId,
      title: args.title,
      starts_at: args.startsAt,
      ends_at: args.endsAt,
    },
    withTimeout(DEFAULT_TIMEOUT_MS),
  );

  if (status < 200 || status >= 300) {
    throw new BookClientError(
      `Book event create returned HTTP ${status}`,
      'http',
      status,
      text,
    );
  }

  // Accept either { data: { book_event_id, meeting_url } } (envelope
  // matching the rest of the api) or a flat { book_event_id, meeting_url }
  // — we control the inbound route but be liberal in what we accept so
  // future shape changes do not require a coordinated deploy.
  const root = (json ?? {}) as Record<string, unknown>;
  const data =
    (root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root) ?? {};

  const bookEventId =
    typeof data.book_event_id === 'string' ? data.book_event_id : null;
  if (!bookEventId) {
    throw new BookClientError(
      'Book event create response missing book_event_id',
      'http',
      status,
      text,
    );
  }
  const meetingUrl =
    typeof data.meeting_url === 'string' && data.meeting_url.length > 0
      ? data.meeting_url
      : null;

  return { bookEventId, meetingUrl };
}

/**
 * Cancel a Book event by id. Idempotent: a 404 (event already gone) is
 * treated as success because the caller's intent — "this Book event
 * should be cancelled" — is satisfied either way.
 *
 * Any other non-2xx surfaces as a BookClientError so the caller can log
 * the divergence. Bureau itself still cancels the local row regardless,
 * because the user-facing operation must not block on calendar sync.
 */
export async function cancelBookEvent(bookEventId: string): Promise<void> {
  if (!bookEventId) return;
  const { status, text } = await postJson(
    `/v1/internal/events/${encodeURIComponent(bookEventId)}/cancel`,
    null,
    withTimeout(DEFAULT_TIMEOUT_MS),
  );
  if (status === 404) return;
  if (status < 200 || status >= 300) {
    throw new BookClientError(
      `Book event cancel returned HTTP ${status}`,
      'http',
      status,
      text,
    );
  }
}

/**
 * Fetch a Book event by id. Returns null on 404. Throws BookClientError
 * for any other failure mode.
 */
export async function getBookEvent(
  bookEventId: string,
): Promise<BookEventPayload | null> {
  if (!bookEventId) return null;
  const { status, json, text } = await getJson(
    `/v1/internal/events/${encodeURIComponent(bookEventId)}`,
    withTimeout(DEFAULT_TIMEOUT_MS),
  );
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new BookClientError(
      `Book event get returned HTTP ${status}`,
      'http',
      status,
      text,
    );
  }

  const root = (json ?? {}) as Record<string, unknown>;
  const data =
    (root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root) ?? {};

  // Minimal shape validation — we trust the peer service but bail loudly
  // if the contract drifts.
  const id = typeof data.id === 'string' ? data.id : null;
  const title = typeof data.title === 'string' ? data.title : null;
  const eventStatus = typeof data.status === 'string' ? data.status : null;
  const startAt = typeof data.start_at === 'string' ? data.start_at : null;
  const endAt = typeof data.end_at === 'string' ? data.end_at : null;
  const orgId =
    typeof data.organization_id === 'string' ? data.organization_id : null;
  const calendarId =
    typeof data.calendar_id === 'string' ? data.calendar_id : null;
  if (
    !id ||
    !title ||
    !eventStatus ||
    !startAt ||
    !endAt ||
    !orgId ||
    !calendarId
  ) {
    throw new BookClientError(
      'Book event get response missing required fields',
      'http',
      status,
      text,
    );
  }

  return {
    id,
    title,
    status: eventStatus,
    start_at: startAt,
    end_at: endAt,
    meeting_url:
      typeof data.meeting_url === 'string' ? data.meeting_url : null,
    organization_id: orgId,
    calendar_id: calendarId,
  };
}
