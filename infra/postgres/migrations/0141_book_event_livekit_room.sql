-- 0141_book_event_livekit_room.sql
-- Why: D-4 — Book events become joinable calls in the v2 unified-call
--   model. The column records the canonical LiveKit room for an event
--   (huddle-book-{eventId} for Book-native events, bureau-room-{roomId}
--   for Bureau room reservations) so calendar rows, iCal exports, and
--   Bolt payloads can advertise a real "join" target.
-- Client impact: additive only.

ALTER TABLE book_events ADD COLUMN IF NOT EXISTS livekit_room_name text;
