-- 0217_bay_review_links.sql
-- Why: Public guest review. A reviewer mints a share link for a Bay review; an
--      unauthenticated guest opens it to view the media + annotations + decision
--      summary and (optionally) leave a comment. The token is the sole bearer of
--      access, so it is long + random and revocable, with an optional expiry.
-- Client impact: additive only. One new table + one nullable column on
--      bay_annotations (guest_name, for attributing guest comments). Re-runs are
--      safe (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS bay_review_links (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id       UUID NOT NULL REFERENCES bay_assets(id) ON DELETE CASCADE,
  -- 24 random bytes hex-encoded (48 chars) — unguessable bearer token.
  token          VARCHAR(64) NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  allow_comments BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ,
  view_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bay_review_links_token ON bay_review_links(token);
CREATE INDEX IF NOT EXISTS idx_bay_review_links_org ON bay_review_links(org_id);
CREATE INDEX IF NOT EXISTS idx_bay_review_links_asset ON bay_review_links(asset_id);

-- Attribute guest comments (author_id is NULL for guests; this carries the name
-- the guest typed). The annotation list coalesces user display_name -> guest_name.
ALTER TABLE bay_annotations ADD COLUMN IF NOT EXISTS guest_name VARCHAR(120);
