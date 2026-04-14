-- 0078_reconcile_bam_bearing_drift.sql
-- Why: Reconcile drift between Drizzle schemas and applied SQL migrations
--   that db-check first surfaced on a fresh DB after the migration 0023
--   cold-start abort was fixed. Four columns are declared in Drizzle but
--   missing from the DB. Adding them as additive, nullable columns so
--   existing rows are unaffected. `tasks.org_id` is load-bearing for the
--   Wave 1 RLS rollout (Platform §3.3 assumes core tables carry org_id).
--   See DECISIONS.md D-007 and D-008 for context.
-- Client impact: additive only. All four new columns are nullable. No
--   existing SELECT or INSERT path changes. A separate Wave 1 follow-up
--   will backfill `tasks.org_id` from `projects.org_id` and switch it to
--   NOT NULL before RLS policies rely on it.

BEGIN;

-- guest_invitations.revoked_at: declared in Drizzle
-- (apps/api/src/db/schema/guest-invitations.ts) since the consolidated
-- people-management work; never got a companion migration. Nullable
-- because only revoked rows populate it.
ALTER TABLE guest_invitations
    ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- impersonation_sessions.reason: declared in Drizzle
-- (apps/api/src/db/schema/impersonation-sessions.ts) to record why a
-- superuser started an impersonation session. Nullable because the
-- existing CLI + audit routes do not enforce a reason today.
ALTER TABLE impersonation_sessions
    ADD COLUMN IF NOT EXISTS reason text;

-- tasks.org_id: the Bam `tasks` table has never carried an org_id of its
-- own; org scoping has flowed through `projects.org_id`. Wave 1 RLS
-- policies assume every row-level-scoped table has an org_id, so this
-- migration adds the column ahead of that rollout. Nullable here; the
-- Wave 1 Platform migration will backfill from projects and flip NOT
-- NULL before attaching the RLS policy.
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS tasks_org_id_idx ON tasks(org_id);

-- bearing_updates.status: the bearing-updates Drizzle schema declares a
-- status tag ('on_track' / 'at_risk' / 'behind' / 'achieved' / 'missed')
-- on every update row so the UI can color-code historical entries. It
-- was never added to the DB by migration 0028 or 0029. Nullable so the
-- pre-existing (empty on most installs) rows stay valid; the Bearing
-- service always writes it on new inserts.
ALTER TABLE bearing_updates
    ADD COLUMN IF NOT EXISTS status varchar(20);

COMMIT;
