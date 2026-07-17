-- 0228_bench_widget_metric_binding.sql
-- Why: let a Bench widget bind to a certified Basis metric so a KPI labeled "MRR"
--   everywhere resolves to one certified definition + presentation envelope
--   (design spec section 3.2). Additive column on the existing bench_widgets.
-- Client impact: additive only. Nullable column; existing widgets unaffected.

ALTER TABLE bench_widgets
    ADD COLUMN IF NOT EXISTS basis_metric_id uuid;

-- Nullable FK; a bound metric being deprecated should not delete the widget, so
-- ON DELETE SET NULL. Guarded/idempotent.
DO $$ BEGIN
    ALTER TABLE bench_widgets
        ADD CONSTRAINT fk_bench_widgets_basis_metric
        FOREIGN KEY (basis_metric_id) REFERENCES basis_metrics(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bench_widgets_basis_metric
    ON bench_widgets(basis_metric_id)
    WHERE basis_metric_id IS NOT NULL;
