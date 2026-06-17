-- 0198_bill_recurring_invoices.sql
-- Why: Bill task #60 — recurring/subscription billing. Adds a schedule table
--   (client + template fields + cadence + next_run_at + lifecycle status) and
--   a line-item template child table so the daily worker tick can materialise
--   real draft/finalized invoices on cadence. Also seeds the new
--   bill.recurring_invoice.* permission catalog rows and grants them to the
--   built-in groups, mirroring the bill.invoice.* grant shape (members draft
--   and manage, admin+ cancel; everyone with bill read can list/get).
-- Client impact: additive only. New tables, new permissions, new group
--   defaults. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS,
--   INSERT ... ON CONFLICT DO NOTHING/UPDATE.

-- ──────────────────────────────────────────────────────────────────────
-- Schedule table
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bill_recurring_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES bill_clients(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  name varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active', -- active | paused | cancelled
  cadence varchar(20) NOT NULL,                  -- weekly | monthly | quarterly | annually
  -- Whether generated invoices are left as draft or auto-finalized.
  auto_finalize boolean NOT NULL DEFAULT false,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  tax_rate numeric(5, 2) DEFAULT '0',
  discount_amount bigint NOT NULL DEFAULT 0,
  payment_terms_days integer NOT NULL DEFAULT 30,
  payment_instructions text,
  notes text,
  footer_text text,
  terms_text text,
  -- Scheduling window. start_date is the first eligible run; next_run_at is the
  -- next time the sweep should generate; end_date (optional) caps the series.
  start_date date NOT NULL DEFAULT now(),
  end_date date,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  -- Bookkeeping for the UI / reporting.
  invoices_generated integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bill_recurring_org ON bill_recurring_invoices (organization_id);
CREATE INDEX IF NOT EXISTS idx_bill_recurring_client ON bill_recurring_invoices (client_id);
-- The worker sweep filters on (status, next_run_at); this index keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_bill_recurring_due ON bill_recurring_invoices (status, next_run_at);

-- ──────────────────────────────────────────────────────────────────────
-- Line-item template child table
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bill_recurring_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_invoice_id uuid NOT NULL REFERENCES bill_recurring_invoices(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  quantity numeric(10, 2) NOT NULL DEFAULT '1',
  unit varchar(20) DEFAULT 'units',
  unit_price bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bill_recurring_items_parent
  ON bill_recurring_line_items (recurring_invoice_id, sort_order);

-- ──────────────────────────────────────────────────────────────────────
-- Permission catalog rows
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bill.recurring_invoice.create',       'bill', 'recurring_invoice', 'create',       'bill recurring_invoice create',       false, false, false, false),
    ('bill.recurring_invoice.list',         'bill', 'recurring_invoice', 'list',         'bill recurring_invoice list',         false, false, true,  false),
    ('bill.recurring_invoice.get',          'bill', 'recurring_invoice', 'get',          'bill recurring_invoice get',          false, false, true,  false),
    ('bill.recurring_invoice.update',       'bill', 'recurring_invoice', 'update',       'bill recurring_invoice update',       false, false, false, false),
    ('bill.recurring_invoice.pause',        'bill', 'recurring_invoice', 'pause',        'bill recurring_invoice pause',        false, false, false, false),
    ('bill.recurring_invoice.resume',       'bill', 'recurring_invoice', 'resume',       'bill recurring_invoice resume',       false, false, false, false),
    ('bill.recurring_invoice.cancel',       'bill', 'recurring_invoice', 'cancel',       'bill recurring_invoice cancel',       true,  true,  false, false),
    ('bill.recurring_invoice.generate_now', 'bill', 'recurring_invoice', 'generate_now', 'bill recurring_invoice generate_now', false, false, false, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;

-- ──────────────────────────────────────────────────────────────────────
-- Built-in group default grants
--
-- Read verbs (list/get) follow bill.invoice.list — granted to every group
-- that already has it (owner/admin/member/viewer). Write verbs
-- (create/update/pause/resume/generate_now) follow bill.invoice.create.
-- The destructive cancel follows bill.invoice.delete (admin/owner only).
-- Granting "mirror the analogous existing permission" keeps the new feature
-- aligned with the financial-finality posture without widening any group's
-- authority. Idempotent via ON CONFLICT DO NOTHING.
-- ──────────────────────────────────────────────────────────────────────

-- Read: mirror bill.invoice.list
INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT pgd.group_id, v.perm, pgd.granted
FROM permission_group_defaults pgd
CROSS JOIN (VALUES
  ('bill.recurring_invoice.list'),
  ('bill.recurring_invoice.get')
) AS v(perm)
WHERE pgd.permission_id = 'bill.invoice.list'
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- Write: mirror bill.invoice.create
INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT pgd.group_id, v.perm, pgd.granted
FROM permission_group_defaults pgd
CROSS JOIN (VALUES
  ('bill.recurring_invoice.create'),
  ('bill.recurring_invoice.update'),
  ('bill.recurring_invoice.pause'),
  ('bill.recurring_invoice.resume'),
  ('bill.recurring_invoice.generate_now')
) AS v(perm)
WHERE pgd.permission_id = 'bill.invoice.create'
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- Destructive cancel: mirror bill.invoice.delete (admin/owner only)
INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT pgd.group_id, 'bill.recurring_invoice.cancel', pgd.granted
FROM permission_group_defaults pgd
WHERE pgd.permission_id = 'bill.invoice.delete'
ON CONFLICT (group_id, permission_id) DO NOTHING;
