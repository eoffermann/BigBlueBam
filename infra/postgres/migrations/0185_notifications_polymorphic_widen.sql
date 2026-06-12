-- 0185_notifications_polymorphic_widen.sql
-- Client impact: additive only — widens a CHECK and relaxes a NOT NULL;
--      existing rows and inserts keep working unchanged.
-- Why: The notifications table was advertised as "polymorphic" in
--      migration 0019 (its header literally says so), but two of the
--      constraints still encode a Bam-centric assumption:
--        - source_app CHECK restricts inserts to 'bbb' | 'banter' |
--          'helpdesk' — beacon-expiry-sweep tried to enqueue
--          beacon-pending-review notifications and would have hit a
--          23514 if it had ever produced a syntactically valid INSERT
--          (it didn't, see below).
--        - project_id is NOT NULL, but the polymorphic plan was for
--          notifications to attach to an org alone (no project) for
--          banter-channel-invite, beacon-pending-review on an
--          org-scoped beacon, etc.
--      The beacon-expiry-sweep worker was hitting BOTH constraints
--      indirectly: the upstream job-data was missing the user_id /
--      title / body fields the processor expects, drizzle's `sql`
--      tag with `undefined` interpolation produced an INSERT with
--      empty parameter slots ("syntax error at or near ','"), and
--      even if the SQL had been well-formed the constraint would
--      have failed it. Both errors were masking the real fix.
--
-- Client impact: data-only relaxation. Widening the CHECK
--      constraint and relaxing project_id to NULL only affects rows
--      we couldn't insert before, so nothing existing breaks.

-- 1. project_id is no longer required. The polymorphic notification
--    model attaches to a user and (optionally) an org / project /
--    task. Banter channel invites and beacon lifecycle notifications
--    are the immediate beneficiaries; future B-named apps will be
--    too.
ALTER TABLE notifications
  ALTER COLUMN project_id DROP NOT NULL;

-- 2. Widen the source_app check to every B-named satellite plus
--    Bureau and Board. Listed individually (not removed entirely)
--    so a typo'd source still trips the constraint and surfaces in
--    the System Console rather than silently writing garbage rows.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_source_app_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_source_app_check
  CHECK (source_app IN (
    'bbb',
    'banter',
    'helpdesk',
    'beacon',
    'bearing',
    'bench',
    'bill',
    'blank',
    'blast',
    'blueprint',
    'board',
    'bolt',
    'bond',
    'book',
    'brief',
    'bureau'
  ));
