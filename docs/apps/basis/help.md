# Basis - Governed Metric Layer

Basis gives your whole suite **one trusted definition per number**, and an AI core
that explains, in plain language, *why* a metric moved. Define "MRR" or "pipeline"
once; every app, chart, and agent reads the same certified definition.

## What Basis is for

- **One definition of truth.** Stop getting three different "revenue" numbers from
  Bench, Bond, and Bill. Define a metric once, certify it, and it is the org-wide
  source of truth. A Bench widget can bind to a Basis metric so the KPI labeled
  "MRR" everywhere resolves to the same certified definition and presentation.
- **Why did it change?** When a certified metric moves, Basis decomposes the delta
  across a dimension (an exact, shared breakdown for additive measures) and, as a
  separate per-viewer aid, surfaces the concrete cross-app activity that may have
  contributed - each item access-scoped to what you're allowed to see.

Basis does **not** render charts (Bench does) or own the underlying data. It defines
metrics *over* data that already lives in Bond, Bill, Bam, and the rest, reaching it
through Bench's governed query builder.

## The Metric Catalog

The catalog lists every metric with its certification badge, owner, and unit. Filter
by **Certified / Draft / Deprecated**. A `resolve_failed` badge warns when a metric's
definition no longer resolves against its source (for example a renamed field).

## Defining a metric

Use **Define a metric** on the catalog:

- **slug** - a stable snake_case id (e.g. `mrr`), unique per org.
- **name**, **unit** (currency / count / percent / ratio / duration_ms).
- **source product** + **source entity** - where the data lives (e.g. `bill` /
  `invoices`).
- **measure field** + **agg** (sum / count / avg / min / max).
- **time column** - the column periods are measured against.

Every new metric starts as a **draft**. Certifying is a separate, deliberate step.

## The certification lifecycle

- **Certify** - promotes a draft to the org-wide source of truth. This is a
  truth-flip: agents doing it need a confirmation step.
- **Decertify** - returns a certified metric to draft.
- **Deprecate** - soft-retires a metric.

Each definition change creates an **immutable version**; the version history is on
the metric detail page, so you can always see how "MRR" was defined at any point.

## Why-did-it-change

Open a certified metric and ask why it changed between two periods. Basis shows:

1. **Certified drivers** - the exact dimension-value contributions (e.g. "Enterprise
   segment -$3.2k"). For additive measures these reconcile to the total delta.
2. **Possibly related activity** - a separate, lower-ranked, per-viewer list of
   concrete cross-app events, shown only for entities you can access.

The two are never merged: the certified number is shared and exact, while the
per-entity breakdown is access-scoped and deliberately non-invertible (a viewer
missing access to some entities gets a k-anonymous breakdown that will not let them
back out a hidden entity's amount).

## For AI agents

Basis exposes MCP tools so agents read the same certified metrics you do:
`basis_list_metrics`, `basis_get_metric`, `basis_metric_value`,
`basis_explain_change`, `basis_rank_drivers` (both require the human's
`asker_user_id` so per-entity visibility is enforced), plus define/version/certify/
decertify/deprecate under confirmation. Truth-flips (certify/deprecate) require a
confirmation token, and every `basis.*` tool is fail-closed under agent policies
until an operator allowlists it.

## Settings

Per-org: the default decomposition dimension, the explanation cache TTL, and the
snapshot retention window. Shortening the retention window only affects your org's
data.
