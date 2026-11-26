-- 0289_beacon_slug_org_scoped_unique.sql
-- Why: issue #246 (BCN-1). beacon_entries.slug carried a GLOBAL unique constraint
--   (beacon_entries_slug_key from 0023), so every tenant shared one slug namespace and
--   upsert-by-slug resolved a caller-supplied slug to another org's row. A slug is a
--   per-tenant natural key, so uniqueness belongs on (organization_id, slug).
--   Ported from the never-pushed 0228_beacon_slug_org_scoped_unique; dev DBs that ran
--   that file already have beacon_entries_org_slug_key and no global key, so this file
--   reuses the same index name and both paths converge on one shape.
-- Client impact: additive only for correct callers. Slugs stay unique within an org; two
--   orgs may now hold the same slug. Every application slug lookup is org-scoped in the
--   same change. Converting global -> per-org can never fail on existing data.

-- Drop every unique constraint, and every standalone unique index, whose key is exactly
-- (slug). Matches by shape rather than by name so a differently named global key is
-- also removed. No-op on a DB where it is already gone.
DO $$
DECLARE
    slug_attnum smallint;
    r record;
BEGIN
    SELECT attnum INTO slug_attnum
      FROM pg_attribute
     WHERE attrelid = 'beacon_entries'::regclass AND attname = 'slug' AND NOT attisdropped;

    FOR r IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'beacon_entries'::regclass
           AND contype = 'u'
           AND conkey = ARRAY[slug_attnum]
    LOOP
        EXECUTE format('ALTER TABLE beacon_entries DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;

    FOR r IN
        SELECT ic.relname AS idxname
          FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = 'beacon_entries'::regclass
           AND i.indisunique
           AND NOT i.indisprimary
           AND i.indnatts = 1
           AND i.indkey[0] = slug_attnum
           AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', r.idxname);
    END LOOP;
EXCEPTION
    WHEN undefined_table THEN NULL;
END $$;

-- Tenant-scoped uniqueness: the real invariant. Same name as the local-only 0228 so a
-- DB that already ran it sees this as a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS beacon_entries_org_slug_key
    ON beacon_entries (organization_id, slug);
