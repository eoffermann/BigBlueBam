-- 0177_bureau_seed_demo_floor.sql
-- Why: Seeds a demo floor so the empty Bureau state is never truly empty:
--      one floor with two offices (one for the discoverable org owner,
--      one generic), two huddle rooms, one bookable conference room
--      (the "War Room", 8 seats), and one unbounded lounge. Gives
--      reviewers, screenshots, and the human-tester checklist somewhere
--      to land the very first time they open /bureau/.
-- Client impact: additive only. The seed picks a host org via PL/pgSQL:
--      the first existing organization that is NOT a hidden sentinel
--      (slug not starting with `__`). If no real org exists yet (fresh
--      install pre-bootstrap), the entire seed exits cleanly without
--      writing a single row. Every INSERT uses ON CONFLICT DO NOTHING
--      keyed on a stable deterministic UUID so re-running the migration
--      is a no-op, even after rooms have been renamed or rezoned by an
--      admin. Per CLAUDE.md, migrations are immutable once applied; the
--      DO block is the only safe way to express "create if a parent exists".

DO $$
DECLARE
    v_org_id          uuid;
    v_owner_id        uuid;
    v_floor_id        uuid := 'a0000000-0000-4000-8000-bbb00000f100';
    v_office_owner_id uuid := 'a0000000-0000-4000-8000-bbb00000a001';
    v_office_guest_id uuid := 'a0000000-0000-4000-8000-bbb00000a002';
    v_huddle_a_id     uuid := 'a0000000-0000-4000-8000-bbb00000a003';
    v_huddle_b_id     uuid := 'a0000000-0000-4000-8000-bbb00000a004';
    v_war_room_id     uuid := 'a0000000-0000-4000-8000-bbb00000a005';
    v_lounge_id       uuid := 'a0000000-0000-4000-8000-bbb00000a006';
BEGIN
    -- Resolve a host org. Match the convention used by scripts/seed-platform.mjs
    -- (lowest created_at wins) but skip any hidden/sentinel orgs whose slug
    -- starts with `__` (e.g. `__helpdesk_system__` from migration 0014).
    SELECT id
      INTO v_org_id
      FROM organizations
     WHERE slug NOT LIKE '\_\_%' ESCAPE '\'
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_org_id IS NULL THEN
        RAISE NOTICE '[0177_bureau_seed_demo_floor] no host org found; skipping seed';
        RETURN;
    END IF;

    -- Pick a plausible office owner: an active, non-sentinel user in the org.
    -- Prefer a superuser/admin if one exists; otherwise the oldest active user.
    -- If none exists, the owner office still seeds with owner_id NULL.
    SELECT id
      INTO v_owner_id
      FROM users
     WHERE org_id = v_org_id
       AND is_active = true
       AND email NOT LIKE 'system-%@bigbluebam.internal'
     ORDER BY is_superuser DESC, created_at ASC
     LIMIT 1;

    -- ── Floor ──────────────────────────────────────────────────────────────
    INSERT INTO bureau_floors (
        id, org_id, building_id, name, slug, layout,
        background_url, position, is_default
    )
    VALUES (
        v_floor_id,
        v_org_id,
        NULL,
        'Main Floor',
        'main-floor',
        jsonb_build_object(
            'width', 1200,
            'height', 800,
            'zones', jsonb_build_array(
                jsonb_build_object('id', 'zone-office-owner', 'shape', 'rect', 'x',  60, 'y',  60, 'w', 220, 'h', 160, 'label', 'Owner Office'),
                jsonb_build_object('id', 'zone-office-guest', 'shape', 'rect', 'x', 300, 'y',  60, 'w', 220, 'h', 160, 'label', 'Guest Office'),
                jsonb_build_object('id', 'zone-huddle-a',     'shape', 'rect', 'x',  60, 'y', 260, 'w', 180, 'h', 140, 'label', 'Huddle A'),
                jsonb_build_object('id', 'zone-huddle-b',     'shape', 'rect', 'x', 260, 'y', 260, 'w', 180, 'h', 140, 'label', 'Huddle B'),
                jsonb_build_object('id', 'zone-war-room',     'shape', 'rect', 'x', 560, 'y',  60, 'w', 360, 'h', 240, 'label', 'War Room'),
                jsonb_build_object('id', 'zone-lounge',       'shape', 'rect', 'x', 480, 'y', 360, 'w', 480, 'h', 320, 'label', 'Lounge')
            ),
            'walls', jsonb_build_array()
        ),
        NULL,
        0,
        true
    )
    ON CONFLICT (id) DO NOTHING;

    -- Per-org settings row so the seeded floor has explicit defaults rather
    -- than relying on application fallback. Safe no-op if a row exists.
    INSERT INTO bureau_settings (org_id)
    VALUES (v_org_id)
    ON CONFLICT (org_id) DO NOTHING;

    -- ── Rooms ──────────────────────────────────────────────────────────────
    -- Owner office: knock-by-default, the discoverable org owner gets the key.
    INSERT INTO bureau_rooms (
        id, org_id, floor_id, name, type, privacy_default,
        capacity, bookable, zone_id, owner_id
    )
    VALUES (
        v_office_owner_id, v_org_id, v_floor_id,
        'Owner Office', 'office', 'knock',
        1, false, 'zone-office-owner', v_owner_id
    )
    ON CONFLICT (id) DO NOTHING;

    -- Generic guest office: also knock-default, no fixed owner.
    INSERT INTO bureau_rooms (
        id, org_id, floor_id, name, type, privacy_default,
        capacity, bookable, zone_id, owner_id
    )
    VALUES (
        v_office_guest_id, v_org_id, v_floor_id,
        'Guest Office', 'office', 'knock',
        1, false, 'zone-office-guest', NULL
    )
    ON CONFLICT (id) DO NOTHING;

    -- Huddle A: small open drop-in, 4 seats.
    INSERT INTO bureau_rooms (
        id, org_id, floor_id, name, type, privacy_default,
        capacity, bookable, zone_id, owner_id
    )
    VALUES (
        v_huddle_a_id, v_org_id, v_floor_id,
        'Huddle A', 'huddle', 'open',
        4, false, 'zone-huddle-a', NULL
    )
    ON CONFLICT (id) DO NOTHING;

    -- Huddle B: small open drop-in, 4 seats.
    INSERT INTO bureau_rooms (
        id, org_id, floor_id, name, type, privacy_default,
        capacity, bookable, zone_id, owner_id
    )
    VALUES (
        v_huddle_b_id, v_org_id, v_floor_id,
        'Huddle B', 'huddle', 'open',
        4, false, 'zone-huddle-b', NULL
    )
    ON CONFLICT (id) DO NOTHING;

    -- War Room: 8-seat bookable conference room.
    INSERT INTO bureau_rooms (
        id, org_id, floor_id, name, type, privacy_default,
        capacity, bookable, zone_id, owner_id
    )
    VALUES (
        v_war_room_id, v_org_id, v_floor_id,
        'War Room', 'conference', 'open',
        8, true, 'zone-war-room', NULL
    )
    ON CONFLICT (id) DO NOTHING;

    -- Lounge: unbounded open space (capacity NULL).
    INSERT INTO bureau_rooms (
        id, org_id, floor_id, name, type, privacy_default,
        capacity, bookable, zone_id, owner_id
    )
    VALUES (
        v_lounge_id, v_org_id, v_floor_id,
        'Lounge', 'lounge', 'open',
        NULL, false, 'zone-lounge', NULL
    )
    ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE '[0177_bureau_seed_demo_floor] seeded floor % into org %', v_floor_id, v_org_id;
END $$;
