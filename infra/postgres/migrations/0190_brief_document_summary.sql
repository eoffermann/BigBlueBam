-- 0190_brief_document_summary.sql
-- Why: Brief's document editor has a "Brief summary" field, but the backend
--      never had a column for it. The create/update Zod schemas stripped the
--      `summary` key and the service had nothing to persist to, so every
--      summary was silently discarded — even for the author. Add the column so
--      the field round-trips (and so the collaborative meta-sync can flush it).
-- Client impact: additive only (new nullable column; existing rows get NULL).

ALTER TABLE brief_documents ADD COLUMN IF NOT EXISTS summary text;
