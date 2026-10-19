-- One-time privacy scrub of ALREADY-STORED Blip telemetry for one tracked app.
--
-- Why: before the `pseudonymize` transform existed, the Frndo iOS client's
-- install id (user.user_id) and Apple vendor id (user.device_unique_identifier,
-- which the Frndo users service also stores as device_id) were stored raw, so
-- stored events could be joined to a Frndo account. This brings history in line
-- with the new ingest rules:
--   * user.device_unique_identifier  -> removed
--   * device.device_name             -> removed
--   * metrics.message                -> removed (free text; could hold HTTP bodies),
--                                       except in reports whose
--                                       metadata.privacy_version >= 2 (builds that
--                                       strip bodies and URLs client-side)
--   * user.user_id                   -> replaced by sha256(month_salt || id), where
--                                       month_salt is random per UTC calendar month
--                                       of the row and exists only inside this
--                                       transaction (pg_temp), then is gone. Same
--                                       install in the same month keeps one code
--                                       (unique counts per month still work);
--                                       nothing can link the codes back.
--
-- Covers: blip_entries.payload, blip_watch_events.context (match snapshots), and
-- bolt_executions.trigger_event rows fired by blip watches on this app.
-- Does NOT cover JSONL exports already written to object storage
-- (<org_id>/blip/exports/*.jsonl); delete those separately.
--
-- ORDER MATTERS: deploy the blip-api build with the `pseudonymize` action and
-- save the app's transform rules FIRST, so no new raw rows arrive after this runs.
--
-- Usage (prints progress; runs in one transaction):
--   psql "$DATABASE_URL" -v app_id=<tracked_app uuid> -f pseudonymize-app-history.sql
-- Rehearse with -v dry_run=1 to see counts and roll back.

\set ON_ERROR_STOP on
\pset pager off
\if :{?dry_run}
\else
  \set dry_run 0
\endif

BEGIN;

\echo '[1/6] app being scrubbed:'
SELECT id, name, org_id FROM blip_tracked_apps WHERE id = :'app_id';

CREATE TEMP TABLE month_salts (month text PRIMARY KEY, salt text NOT NULL) ON COMMIT DROP;

-- True when a report object came from a build that cleans metrics.message itself.
CREATE FUNCTION pg_temp.blip_clean_build(doc jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_typeof(doc #> '{metadata,privacy_version}') = 'number'
     AND (doc #>> '{metadata,privacy_version}')::numeric >= 2
$fn$;

-- Recursively scrub one jsonb document with the salt for its month. keep_msg
-- carries "this subtree is a privacy_version >= 2 report" down to its metrics.
CREATE FUNCTION pg_temp.blip_scrub(doc jsonb, salt text, keep_msg boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  k text;
  v jsonb;
  out jsonb;
BEGIN
  IF doc IS NULL THEN
    RETURN NULL;
  ELSIF jsonb_typeof(doc) = 'array' THEN
    SELECT COALESCE(jsonb_agg(pg_temp.blip_scrub(e, salt, keep_msg)), '[]'::jsonb) INTO out
      FROM jsonb_array_elements(doc) AS e;
    RETURN out;
  ELSIF jsonb_typeof(doc) <> 'object' THEN
    RETURN doc;
  END IF;
  keep_msg := keep_msg OR COALESCE(pg_temp.blip_clean_build(doc), false);
  out := '{}'::jsonb;
  FOR k, v IN SELECT * FROM jsonb_each(doc) LOOP
    IF k IN ('device_unique_identifier', 'device_name') THEN
      CONTINUE;
    ELSIF k = 'user' AND jsonb_typeof(v) = 'object' THEN
      v := v - 'device_unique_identifier';
      IF v ? 'user_id' AND jsonb_typeof(v -> 'user_id') = 'string'
         AND (v ->> 'user_id') !~ '^[0-9a-f]{32}$' THEN
        v := jsonb_set(v, '{user_id}',
          to_jsonb(left(encode(sha256(convert_to(salt || (v ->> 'user_id'), 'UTF8')), 'hex'), 32)));
      END IF;
      out := out || jsonb_build_object(k, v);
    ELSIF k = 'metrics' AND jsonb_typeof(v) = 'object' THEN
      IF NOT keep_msg THEN
        v := v - 'message';
      END IF;
      out := out || jsonb_build_object(k, pg_temp.blip_scrub(v, salt, keep_msg));
    ELSE
      out := out || jsonb_build_object(k, pg_temp.blip_scrub(v, salt, keep_msg));
    END IF;
  END LOOP;
  RETURN out;
END
$fn$;

\echo '[2/6] generating one throwaway salt per month present in the data...'
INSERT INTO month_salts (month, salt)
SELECT m, gen_random_uuid()::text || gen_random_uuid()::text
FROM (
  SELECT to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM') AS m FROM blip_entries WHERE tracked_app_id = :'app_id'
  UNION
  SELECT to_char(fired_at AT TIME ZONE 'UTC', 'YYYY-MM') FROM blip_watch_events WHERE tracked_app_id = :'app_id'
  UNION
  SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') FROM bolt_executions
   WHERE trigger_event::text LIKE '%' || :'app_id' || '%'
) months;
SELECT count(*) AS months FROM month_salts;

\echo '[3/6] rows still holding raw identifiers BEFORE:'
SELECT
  (SELECT count(*) FROM blip_entries WHERE tracked_app_id = :'app_id'
     AND (payload::text ~ '"(device_unique_identifier|device_name)"'
          OR (payload -> 'metrics' ? 'message' AND NOT COALESCE(pg_temp.blip_clean_build(payload), false))
          OR (payload -> 'user' ->> 'user_id') !~ '^[0-9a-f]{32}$')) AS entries,
  (SELECT count(*) FROM blip_watch_events WHERE tracked_app_id = :'app_id'
     AND context::text ~ '"(device_unique_identifier|device_name|user_id|message)"') AS watch_events,
  (SELECT count(*) FROM bolt_executions WHERE trigger_event::text LIKE '%' || :'app_id' || '%'
     AND trigger_event::text ~ '"(device_unique_identifier|device_name)"') AS bolt_executions;

\echo '[4/6] scrubbing blip_entries (one pass over the app; may take a while on large apps)...'
UPDATE blip_entries e
   SET payload = pg_temp.blip_scrub(e.payload, s.salt)
  FROM month_salts s
 WHERE e.tracked_app_id = :'app_id'
   AND s.month = to_char(e.received_at AT TIME ZONE 'UTC', 'YYYY-MM');

\echo '[5/6] scrubbing watch-event snapshots and Bolt trigger events...'
UPDATE blip_watch_events w
   SET context = pg_temp.blip_scrub(w.context, s.salt)
  FROM month_salts s
 WHERE w.tracked_app_id = :'app_id'
   AND s.month = to_char(w.fired_at AT TIME ZONE 'UTC', 'YYYY-MM');

UPDATE bolt_executions b
   SET trigger_event = pg_temp.blip_scrub(b.trigger_event, s.salt)
  FROM month_salts s
 WHERE b.trigger_event::text LIKE '%' || :'app_id' || '%'
   AND b.trigger_event::text ~ '"(device_unique_identifier|device_name)"'
   AND s.month = to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM');

\echo '[6/6] rows still holding raw identifiers AFTER (all three must be 0):'
SELECT
  (SELECT count(*) FROM blip_entries WHERE tracked_app_id = :'app_id'
     AND (payload::text ~ '"(device_unique_identifier|device_name)"'
          OR (payload -> 'metrics' ? 'message' AND NOT COALESCE(pg_temp.blip_clean_build(payload), false))
          OR (payload -> 'user' ->> 'user_id') !~ '^[0-9a-f]{32}$')) AS entries,
  (SELECT count(*) FROM blip_watch_events WHERE tracked_app_id = :'app_id'
     AND context::text ~ '"(device_unique_identifier|device_name)"') AS watch_events,
  (SELECT count(*) FROM bolt_executions WHERE trigger_event::text LIKE '%' || :'app_id' || '%'
     AND trigger_event::text ~ '"(device_unique_identifier|device_name)"') AS bolt_executions;

\echo 'NOTE: JSONL exports are not tracked in the DB; they live in object storage at'
\echo '      <org_id>/blip/exports/*.jsonl and are NOT scrubbed by this script. List and delete them separately.'

\if :dry_run
  \echo 'dry_run=1: rolling back, nothing changed.'
  ROLLBACK;
\else
  COMMIT;
  \echo 'Committed. The month salts were dropped with the transaction.'
\endif
