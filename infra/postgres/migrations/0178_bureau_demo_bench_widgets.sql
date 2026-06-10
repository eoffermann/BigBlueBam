-- 0178_bureau_demo_bench_widgets.sql
-- Why: Workstream 14 piece 2 — seed a small starter Bench dashboard for
--      Bureau so the analytics rollup written by the new
--      `bureau.analytics.rollup` worker is immediately visible in /bench/
--      without an operator having to hand-author widgets. Two widgets:
--      a bar chart of peak occupancy this week by floor, and a single-
--      number "Bureau summons today" KPI. Operators can clone and
--      customise these; the seed exists only to give a non-empty
--      first-run experience.
-- Client impact: additive only. New rows in bench_dashboards and
--      bench_widgets; no schema change, no existing-row updates outside
--      the new dashboard's own layout column. Uses ON CONFLICT DO NOTHING
--      keyed on deterministic UUIDs so re-running the migration leaves
--      the seed intact even if the operator has renamed or reconfigured
--      the demo widgets. If no real org or admin user exists yet (fresh
--      install pre-bootstrap), the entire seed exits cleanly without
--      writing a single row. The bench_dashboards / bench_widgets schema
--      requires a NOT NULL created_by user reference; the seed picks the
--      same "first non-sentinel admin" as 0177's owner heuristic.

DO $$
DECLARE
    v_org_id        uuid;
    v_owner_id      uuid;
    v_dashboard_id  uuid := 'a0000000-0000-4000-8000-bbb00000d100';
    v_widget_peak   uuid := 'a0000000-0000-4000-8000-bbb00000d101';
    v_widget_summon uuid := 'a0000000-0000-4000-8000-bbb00000d102';
BEGIN
    -- Resolve a host org — same convention as 0177_bureau_seed_demo_floor.
    SELECT id
      INTO v_org_id
      FROM organizations
     WHERE slug NOT LIKE '\_\_%' ESCAPE '\'
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_org_id IS NULL THEN
        RAISE NOTICE '[0178_bureau_demo_bench_widgets] no host org found; skipping seed';
        RETURN;
    END IF;

    -- Pick an admin / superuser as created_by. Falls through to oldest
    -- active user if no admin exists.
    SELECT id
      INTO v_owner_id
      FROM users
     WHERE org_id = v_org_id
       AND is_active = true
       AND email NOT LIKE 'system-%@bigbluebam.internal'
     ORDER BY is_superuser DESC, created_at ASC
     LIMIT 1;

    IF v_owner_id IS NULL THEN
        RAISE NOTICE '[0178_bureau_demo_bench_widgets] no eligible user found; skipping seed';
        RETURN;
    END IF;

    -- ── Dashboard ──────────────────────────────────────────────────────
    INSERT INTO bench_dashboards (
        id, organization_id, name, description,
        visibility, is_default, auto_refresh_seconds,
        layout, created_by, updated_by
    )
    VALUES (
        v_dashboard_id, v_org_id,
        'Bureau Activity',
        'Starter dashboard for Bureau spatial-presence metrics. Backed by the daily bureau.analytics.rollup worker. Clone and customise to suit your team.',
        'organization', false, 600,
        '[]'::jsonb,
        v_owner_id, v_owner_id
    )
    ON CONFLICT (id) DO NOTHING;

    -- ── Widget 1: Peak occupancy by floor (this week) ─────────────────
    -- Bar chart over bureau_floor_analytics, grouping by floor_id and
    -- summing peak occupancy across the last 7 days. The day filter is
    -- emitted as a SQL CURRENT_DATE expression literal that the data-
    -- source query builder will treat as a static gte; once the operator
    -- clones this widget they can swap to an explicit date or a preset.
    INSERT INTO bench_widgets (
        id, dashboard_id, name, widget_type,
        data_source, entity, query_config, viz_config
    )
    VALUES (
        v_widget_peak, v_dashboard_id,
        'Bureau Peak Occupancy This Week',
        'bar_chart', 'bureau', 'floor_analytics',
        jsonb_build_object(
            'measures', jsonb_build_array(
                jsonb_build_object('field', 'peak_occupancy', 'agg', 'max', 'alias', 'peak')
            ),
            'dimensions', jsonb_build_array(
                jsonb_build_object('field', 'floor_id')
            ),
            'date_range', jsonb_build_object('preset', 'last_7_days'),
            'sort', jsonb_build_array(
                jsonb_build_object('field', 'peak', 'dir', 'desc')
            )
        ),
        jsonb_build_object(
            'colors', jsonb_build_array('#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'),
            'show_legend', false
        )
    )
    ON CONFLICT (id) DO NOTHING;

    -- ── Widget 2: Summons today (single number / KPI card) ────────────
    -- Sum of summon_count for the most recent rollup day. The rollup
    -- writes "yesterday" at midnight UTC, so for most of the working day
    -- this card reads the prior day's totals — that's the right behaviour
    -- for a daily-rollup-backed widget; teams looking for real-time
    -- counters should subscribe to the bureau.summon.issued Bolt event.
    INSERT INTO bench_widgets (
        id, dashboard_id, name, widget_type,
        data_source, entity, query_config, viz_config
    )
    VALUES (
        v_widget_summon, v_dashboard_id,
        'Bureau Summons (Latest Day)',
        'kpi_card', 'bureau', 'floor_analytics',
        jsonb_build_object(
            'measures', jsonb_build_array(
                jsonb_build_object('field', 'summon_count', 'agg', 'sum', 'alias', 'summons')
            ),
            'date_range', jsonb_build_object('preset', 'last_1_days')
        ),
        jsonb_build_object(
            'format', 'number',
            'suffix', 'summons'
        )
    )
    ON CONFLICT (id) DO NOTHING;

    -- Wire the layout. Two widgets side by side at the top of the canvas.
    -- Standard 12-column grid: KPI on the left (4 cols), bar chart on the
    -- right (8 cols). Operators can drag-rearrange after the fact.
    UPDATE bench_dashboards
       SET layout = jsonb_build_array(
               jsonb_build_object('widget_id', v_widget_summon, 'x', 0, 'y', 0, 'w', 4, 'h', 2),
               jsonb_build_object('widget_id', v_widget_peak,   'x', 4, 'y', 0, 'w', 8, 'h', 4)
           ),
           updated_at = NOW()
     WHERE id = v_dashboard_id
       AND (layout IS NULL OR layout = '[]'::jsonb);

    RAISE NOTICE '[0178_bureau_demo_bench_widgets] seeded dashboard % into org %', v_dashboard_id, v_org_id;
END $$;
