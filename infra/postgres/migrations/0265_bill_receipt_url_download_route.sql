-- 0265_bill_receipt_url_download_route.sql
-- Why: Issue #145 / #142. Uploaded expense receipts used to record
--   receipt_url = '/files/bill/receipts/<id>.<ext>', a link through the legacy
--   /files proxy that read a different bucket than the uploader wrote. Receipts
--   are now served only by the authorized bill-api route, so rows written by the
--   old uploader are repointed at it. That leaves nothing linking to the
--   /files/bill/receipts/ prefix, which the api proxy then drops.
-- Client impact: data rewrite of a link column only. Matching rows' receipt_url
--   becomes '/bill/api/v1/expenses/<id>/receipt'; externally supplied receipt
--   URLs (any other value) are untouched. Re-running matches no rows.

UPDATE bill_expenses
   SET receipt_url = '/bill/api/v1/expenses/' || id::text || '/receipt'
 WHERE receipt_url LIKE '/files/bill/receipts/%';
