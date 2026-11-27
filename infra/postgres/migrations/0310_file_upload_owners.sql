-- 0310_file_upload_owners.sql
-- Why: issue #142. GET /files/* served the two remaining legacy prefixes (uploads/ from the Bam
--   api POST /upload, helpdesk/ from helpdesk-api POST /helpdesk/upload) to any signed-in user of
--   ANY org, with no record of who owns an object. This table binds each such key to its org:
--   both upload routes write a row, /files serves a legacy key only to a caller whose active org
--   owns it, and a key with no row is 404. Existing objects are backfilled from the content that
--   links them (task and subtask descriptions, comments, task attachment rows, Bureau floor
--   underlays and layouts, Helpdesk ticket descriptions and messages); when the same key appears
--   in more than one org's content the earliest reference wins, since that is where it was
--   uploaded and pasted.
-- Client impact: additive only. Existing /files links keep working for the owning org; a legacy
--   upload no stored content references (never linked anywhere) becomes 404.

CREATE TABLE IF NOT EXISTS file_upload_owners (
    storage_key text PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- 'bam' (apps/api POST /upload) or 'helpdesk' (helpdesk-api POST /helpdesk/upload)
    source varchar(20) NOT NULL,
    -- users.id for 'bam', helpdesk_users.id for 'helpdesk'; NULL for backfilled rows
    uploaded_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS file_upload_owners_org_idx ON file_upload_owners (org_id);

-- Backfill. A key is `uploads/<uuid>-<name>` or `helpdesk/<uuid>-<name>` (the two routes'
-- format), stored either bare (attachment rows) or inside a `/files/<key>` URL.
INSERT INTO file_upload_owners (storage_key, org_id, source, uploaded_by, created_at)
SELECT DISTINCT ON (ref.storage_key)
       ref.storage_key,
       ref.org_id,
       CASE WHEN ref.storage_key LIKE 'helpdesk/%' THEN 'helpdesk' ELSE 'bam' END,
       NULL::uuid,
       ref.seen_at
FROM (
    SELECT m[1] AS storage_key, COALESCE(t.org_id, p.org_id) AS org_id, t.created_at AS seen_at
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    CROSS JOIN LATERAL regexp_matches(
        COALESCE(t.description, ''),
        '(?:^|/files/)((?:uploads|helpdesk)/[0-9a-fA-F-]{36}-[A-Za-z0-9._-]+)', 'g') AS m
    UNION ALL
    SELECT m[1], COALESCE(t.org_id, p.org_id), c.created_at
    FROM comments c
    JOIN tasks t ON t.id = c.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    CROSS JOIN LATERAL regexp_matches(
        COALESCE(c.body, ''),
        '(?:^|/files/)((?:uploads|helpdesk)/[0-9a-fA-F-]{36}-[A-Za-z0-9._-]+)', 'g') AS m
    UNION ALL
    SELECT m[1], COALESCE(t.org_id, p.org_id), a.created_at
    FROM attachments a
    JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    CROSS JOIN LATERAL regexp_matches(
        COALESCE(a.storage_key, ''),
        '(?:^|/files/)((?:uploads|helpdesk)/[0-9a-fA-F-]{36}-[A-Za-z0-9._-]+)', 'g') AS m
    UNION ALL
    SELECT m[1], f.org_id, f.created_at
    FROM bureau_floors f
    CROSS JOIN LATERAL regexp_matches(
        COALESCE(f.background_url, '') || ' ' || COALESCE(f.layout::text, ''),
        '(?:^|/files/)((?:uploads|helpdesk)/[0-9a-fA-F-]{36}-[A-Za-z0-9._-]+)', 'g') AS m
    UNION ALL
    SELECT m[1], COALESCE(p.org_id, hu.org_id), tk.created_at
    FROM tickets tk
    LEFT JOIN projects p ON p.id = tk.project_id
    LEFT JOIN helpdesk_users hu ON hu.id = tk.helpdesk_user_id
    CROSS JOIN LATERAL regexp_matches(
        COALESCE(tk.description, ''),
        '(?:^|/files/)((?:uploads|helpdesk)/[0-9a-fA-F-]{36}-[A-Za-z0-9._-]+)', 'g') AS m
    UNION ALL
    SELECT m[1], COALESCE(p.org_id, hu.org_id), tm.created_at
    FROM ticket_messages tm
    JOIN tickets tk ON tk.id = tm.ticket_id
    LEFT JOIN projects p ON p.id = tk.project_id
    LEFT JOIN helpdesk_users hu ON hu.id = tk.helpdesk_user_id
    CROSS JOIN LATERAL regexp_matches(
        COALESCE(tm.body, ''),
        '(?:^|/files/)((?:uploads|helpdesk)/[0-9a-fA-F-]{36}-[A-Za-z0-9._-]+)', 'g') AS m
) AS ref
WHERE ref.org_id IS NOT NULL
ORDER BY ref.storage_key, ref.seen_at ASC
ON CONFLICT (storage_key) DO NOTHING;
