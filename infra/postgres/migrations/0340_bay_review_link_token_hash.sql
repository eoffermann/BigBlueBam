-- 0340_bay_review_link_token_hash.sql
-- Why: Bay guest review links stored their bearer token in plaintext (#122), so anyone with read
--   access to the database, a backup, or a query log could open every live guest review. Store
--   only the SHA-256 of the token (looked up by hash, unique), hash every existing row so links
--   already handed out keep working, then drop the plaintext column.
-- Client impact: expand-contract in one step. Existing share URLs keep working (bay-api hashes the
--   presented token). GET /review-links no longer returns token or url: the raw token is shown
--   once, when the link is minted.

ALTER TABLE bay_review_links ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);

-- Hash existing plaintext tokens. Guarded so a re-run after the contract step below is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'bay_review_links' AND column_name = 'token'
  ) THEN
    EXECUTE $sql$
      UPDATE bay_review_links
         SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
       WHERE token_hash IS NULL AND token IS NOT NULL
    $sql$;
  END IF;
END $$;

-- A row with no hash can never be opened; there is none after the backfill, but fail closed.
DELETE FROM bay_review_links WHERE token_hash IS NULL;

-- SET NOT NULL is itself re-runnable; the DO block is the migration-lint convention for it.
DO $$
BEGIN
  ALTER TABLE bay_review_links ALTER COLUMN token_hash SET NOT NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bay_review_links_token_hash ON bay_review_links(token_hash);

-- Contract: the plaintext column (its UNIQUE constraint and lookup index go with it).
DROP INDEX IF EXISTS idx_bay_review_links_token;
DO $$
BEGIN
  ALTER TABLE bay_review_links DROP COLUMN IF EXISTS token;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;
