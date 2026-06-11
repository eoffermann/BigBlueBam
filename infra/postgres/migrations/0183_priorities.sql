-- 0183_priorities.sql
-- Why: Bam ships hardcoded task priorities (Critical/High/Medium/Low/
--      None) but they were always meant to be display names. SuperUsers
--      and org admins should be able to rename them (P0/P1/…) or add
--      and remove levels. This migration adds the per-org table that
--      backs that, seeds it with the five existing defaults for every
--      live org so nothing changes by default, and wires the
--      org-creation path via a one-off backfill. tasks.priority stays
--      as a varchar(20) slug — `value` is what gets stored on the task,
--      so renaming Critical → P0 only changes the display, the API
--      contract is preserved.
-- Client impact: additive only. Existing apps that filter by
--      tasks.priority continue to work — the slug values they read are
--      unchanged. New UI surfaces (the org-level Priorities manager,
--      the usePriorities hook) can pick up the table once the api ships.

CREATE TABLE IF NOT EXISTS priorities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Machine value stored on tasks.priority. Stable across renames so a
  -- Critical-renamed-to-P0 keeps every task pointed at the same row.
  value        varchar(50) NOT NULL,
  -- User-facing label. Rename freely.
  name         varchar(100) NOT NULL,
  -- Hex color (e.g. #ef4444). Replaces the hardcoded Tailwind classes
  -- in apps/frontend/src/lib/utils.ts so renders survive arbitrary colors.
  color        varchar(20) NOT NULL,
  -- Optional Lucide icon name; null = no icon.
  icon         varchar(50),
  -- Sort/swimlane order. 0 is most urgent. Matches the existing
  -- PRIORITY_ORDER in components/board/swimlane-board.tsx.
  position     integer NOT NULL,
  -- Exactly one row per org should be is_default=true. Enforced at the
  -- service layer (no DB unique on (org_id, is_default=true) because
  -- partial uniques play poorly with rollbacks here).
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, value)
);

CREATE INDEX IF NOT EXISTS idx_priorities_org_position
  ON priorities (org_id, position);

-- Backfill: insert the five defaults for every org that doesn't already
-- have priority rows. Idempotent. The order matches the legacy enum:
-- critical < high < medium < low < none. medium is the default.
INSERT INTO priorities (org_id, value, name, color, icon, position, is_default)
SELECT o.id, p.value, p.name, p.color, p.icon, p.position, p.is_default
  FROM organizations o
  CROSS JOIN (VALUES
    ('critical', 'Critical', '#dc2626', 'alert-triangle', 0, false),
    ('high',     'High',     '#f97316', 'arrow-up',       1, false),
    ('medium',   'Medium',   '#eab308', 'minus',          2, true),
    ('low',      'Low',      '#60a5fa', 'arrow-down',     3, false),
    ('none',     'None',     '#a1a1aa',  NULL,            4, false)
  ) AS p(value, name, color, icon, position, is_default)
 WHERE NOT EXISTS (
   SELECT 1 FROM priorities WHERE priorities.org_id = o.id
 )
ON CONFLICT (org_id, value) DO NOTHING;
