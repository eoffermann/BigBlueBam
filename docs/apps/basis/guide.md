---
title: "Basis (Governed Metric Layer) Guide"
app: basis
---

# Basis (Governed Metric Layer) Guide

# Basis - Governed metric layer

Basis is BigBlueBam's governed metric layer: define a business metric once, certify it, and every app, chart, and agent reads the same trusted definition. It answers two questions the rest of the suite cannot answer on its own - "what does this number actually mean" and "why did it move" - without owning the data or drawing the chart. Basis defines metrics over data that already lives in Bond, Bill, Bam, Blast, and the rest, resolving them through Bench's governed query builder at read time.

## Key Features

- **One definition of truth.** A metric is an owned, named object with a unit and a favorable direction. Define it once (source product and entity, a measure field plus an aggregation, a time column, optional filters and dimensions) and certify it, and it becomes the org-wide source of truth. Bench widgets can bind to it so the KPI on a dashboard resolves the same certified definition an agent reads.
- **Certification lifecycle.** Every metric is draft, certified, or deprecated. Certify promotes a draft to the trusted definition; decertify returns it to draft; deprecate soft-retires it. New metrics always start as draft, so certifying is a deliberate, separate step.
- **Immutable version history.** Every definition change appends a new immutable version and bumps the version number; nothing is overwritten. The metric detail page shows exactly how the number was defined at any point in time.
- **Why did it change.** When a certified metric moves between two periods, Basis decomposes the delta across a dimension. For additive measures the per-dimension drivers reconcile exactly to the total change. Class A dimensions (bounded org-global enums like status or stage) are labeled for everyone; Class B (entity-derived) dimensions are resolved per viewer and are deliberately non-invertible, with k-anonymous suppression so a viewer cannot back out a hidden entity's amount.
- **Possibly-related activity.** Separately from the exact certified breakdown, Basis surfaces a per-viewer, access-scoped list of concrete cross-app events that may have contributed to a move - always ranked below the certified drivers and never merged with them.
- **Snapshots, targets, and alerts.** A background job captures snapshots of every certified metric on hourly and daily grains. A metric can carry a target; when a snapshot crosses it, Basis emits a `metric.threshold_breached` Bolt event once per crossing (re-arming on recovery), carrying only magnitude and direction - never entity references.
- **Resolve-status drift guard.** A metric whose definition no longer resolves against its source (for example a renamed field) is flagged `resolve_failed`, so a stale number is visibly distinct from a healthy one.
- **AI agent surface** of `basis_*` MCP tools covering read, search, lineage, value, explanation, and the full define/version/certify/decertify/deprecate lifecycle, with two-step confirmation on truth changes and `agent_policies` fail-closed gating.

## Integrations

Basis reaches source data through **Bench**'s governed internal query route rather than touching any app's tables directly, and a **Bench** widget can bind to a Basis metric (`basis_metric_id`) so a dashboard KPI and an agent's answer resolve the same certified definition. Metrics are defined over entities owned by **Bond**, **Bill**, **Bam**, **Blast**, and other apps; Basis never copies or owns that data. Movement and threshold crossings publish `metric.*` events on the `basis` source to **Bolt**, so an automation rule can route a breach straight into a **Banter** channel, an email, or a webhook. Across the suite, agents reach Basis under an identity with heartbeat and `agent_policies` gating, and the explanation tools require the human's `asker_user_id` so per-entity visibility (`can_access`) is enforced for the person the agent acts for.

## Getting Started

1. Open **Basis** from the Launchpad (or go to `/basis/`). You are signed in already if you are signed in to the suite.
2. On the Metric Catalog, use **Define a metric**: give it a snake_case slug and name, point it at a source product and entity, pick a measure field, aggregation, unit, and time column, and click **Create draft metric**.
3. Open the new metric from the catalog and click **Certify** when you are ready to make it the org-wide source of truth. Use the certification filter to browse Certified, Draft, or Deprecated metrics.
4. Revise a definition by adding a new version (preserving history), and deprecate a metric you no longer trust. Ask why a certified metric moved through the explanation API or the `basis_explain_change` MCP tool.

For the full click-by-click walkthroughs, key concepts, and user stories, see the in-app Help Center (the **?** button, or press `?`), sourced from `docs/apps/basis/help.md`.

## Related

- **Bench** - renders charts and dashboards; a widget binds to a Basis metric and Basis queries source data through Bench.
- **Bond, Bill, Bam, Blast** - own the underlying data Basis defines metrics over.
- **Bolt** - receives `metric.threshold_breached` for target crossings so alerts can be routed anywhere in the suite.
- **Basis MCP-tools reference** - the full `basis_*` tool catalog and confirmation behavior; see `docs/reference/mcp-endpoint-mapping.md`.
