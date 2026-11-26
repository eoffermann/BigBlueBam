-- 0272_bill_expense_receipt_storage_key.sql
-- Why: Issue #169. Receipt uploads held a row lock and a pooled connection across an
--   unbounded S3 put. Each upload now writes its own versioned object key before any
--   transaction opens, then a short locked transaction records which key is current.
--   This column holds that key.
-- Client impact: additive only. Nullable column; rows with NULL keep reading the
--   pre-#169 fixed keys (bill/receipts/<expense-id>, then <expense-id><ext>).

ALTER TABLE bill_expenses ADD COLUMN IF NOT EXISTS receipt_storage_key text;
