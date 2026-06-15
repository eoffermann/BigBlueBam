-- Seed Book (Scheduling & Calendar) demo data
-- Run via orchestrator: node scripts/seed-all.mjs (substitutes :org_id / :user_N)
-- idempotent: skip-if-any-calendar-already-present

DO $$
DECLARE
  v_org UUID := :org_id;
  v_u1 UUID := :user_1;
  v_u2 UUID := :user_2;

  -- Calendars
  cal1 UUID; cal2 UUID;

  -- Events
  e1 UUID; e2 UUID; e3 UUID; e4 UUID; e5 UUID;
  e6 UUID; e7 UUID; e8 UUID; e9 UUID; e10 UUID;
  e11 UUID; e12 UUID; e13 UUID; e14 UUID; e15 UUID;
  e16 UUID; e17 UUID; e18 UUID; e19 UUID; e20 UUID;

  -- Booking page
  bp1 UUID;

BEGIN
  -- Idempotency guard
  IF EXISTS (SELECT 1 FROM book_calendars WHERE organization_id = v_org LIMIT 1) THEN
    RAISE NOTICE 'Book seed: calendars already exist for this org, skipping.';
    RETURN;
  END IF;

  -- ══════════════════════════════════════════════════════════════
  -- 1. CALENDARS (2)
  -- ══════════════════════════════════════════════════════════════

  INSERT INTO book_calendars (organization_id, owner_user_id, name, description, color, calendar_type, is_default, timezone)
  VALUES (v_org, v_u1, 'Eddie''s Calendar', 'Personal calendar for Eddie', '#3b82f6', 'personal', true, 'America/Chicago')
  RETURNING id INTO cal1;

  INSERT INTO book_calendars (organization_id, owner_user_id, name, description, color, calendar_type, is_default, timezone)
  VALUES (v_org, v_u2, 'Sarah''s Calendar', 'Personal calendar for Sarah', '#7c3aed', 'personal', true, 'America/Chicago')
  RETURNING id INTO cal2;

  -- ══════════════════════════════════════════════════════════════
  -- 2. WORKING HOURS
  -- ══════════════════════════════════════════════════════════════

  -- Eddie: Mon-Fri 9am-5pm
  INSERT INTO book_working_hours (user_id, day_of_week, start_time, end_time, timezone, enabled) VALUES
    (v_u1, 1, '09:00', '17:00', 'America/Chicago', true),
    (v_u1, 2, '09:00', '17:00', 'America/Chicago', true),
    (v_u1, 3, '09:00', '17:00', 'America/Chicago', true),
    (v_u1, 4, '09:00', '17:00', 'America/Chicago', true),
    (v_u1, 5, '09:00', '17:00', 'America/Chicago', true)
  -- Seed users (alice@…, etc.) are shared across orgs (email is globally
  -- unique), so re-seeding their working hours collides on
  -- book_working_hours_user_day_unique. Idempotent skip keeps the seeder
  -- re-runnable and multi-org safe.
  ON CONFLICT (user_id, day_of_week) DO NOTHING;

  -- Sarah: Mon-Fri 8am-4pm
  INSERT INTO book_working_hours (user_id, day_of_week, start_time, end_time, timezone, enabled) VALUES
    (v_u2, 1, '08:00', '16:00', 'America/Chicago', true),
    (v_u2, 2, '08:00', '16:00', 'America/Chicago', true),
    (v_u2, 3, '08:00', '16:00', 'America/Chicago', true),
    (v_u2, 4, '08:00', '16:00', 'America/Chicago', true),
    (v_u2, 5, '08:00', '16:00', 'America/Chicago', true)
  ON CONFLICT (user_id, day_of_week) DO NOTHING;

  -- ══════════════════════════════════════════════════════════════
  -- 3. BOOKING PAGE (1)
  -- ══════════════════════════════════════════════════════════════

  INSERT INTO book_booking_pages (organization_id, owner_user_id, slug, title, description, duration_minutes, buffer_before_min, buffer_after_min, max_advance_days, min_notice_hours, color, enabled)
  VALUES (v_org, v_u1, 'eddie-intro', '30-Minute Intro Call with Eddie', 'Book a quick intro call to discuss your project needs.', 30, 5, 15, 60, 4, '#3b82f6', true)
  RETURNING id INTO bp1;

  -- ══════════════════════════════════════════════════════════════
  -- 4. EVENTS (20)
  -- ══════════════════════════════════════════════════════════════

  -- This week's events (relative to now)
  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Team Standup', 'Daily 15-min standup', now()::date + interval '9 hours', now()::date + interval '9 hours 15 minutes', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e1;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Sprint Planning', 'Plan next sprint tasks', now()::date + interval '10 hours', now()::date + interval '11 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e2;

  INSERT INTO book_events (calendar_id, organization_id, title, description, location, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Client Review: Acme Corp', 'Review project deliverables', 'Zoom', now()::date + interval '1 day 14 hours', now()::date + interval '1 day 15 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e3;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Design Review', 'Review new mockups', now()::date + interval '2 days 11 hours', now()::date + interval '2 days 12 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e4;

  INSERT INTO book_events (calendar_id, organization_id, title, description, meeting_url, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal2, v_org, '1:1 with Eddie', 'Weekly 1:1', 'https://meet.google.com/abc-defg-hij', now()::date + interval '2 days 15 hours', now()::date + interval '2 days 15 hours 30 minutes', 'America/Chicago', 'confirmed', 'busy', v_u2) RETURNING id INTO e5;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Product Roadmap Session', 'Q3 roadmap planning', now()::date + interval '3 days 13 hours', now()::date + interval '3 days 15 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e6;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal2, v_org, 'Marketing Sync', 'Weekly marketing alignment', now()::date + interval '3 days 10 hours', now()::date + interval '3 days 10 hours 45 minutes', 'America/Chicago', 'confirmed', 'busy', v_u2) RETURNING id INTO e7;

  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, all_day, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Company All-Hands', now()::date + interval '4 days', now()::date + interval '5 days', true, 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e8;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Code Review Session', 'Review PR batch', now()::date + interval '4 days 14 hours', now()::date + interval '4 days 15 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e9;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal2, v_org, 'Training: Drizzle ORM', 'Internal training session', now()::date + interval '4 days 11 hours', now()::date + interval '4 days 12 hours 30 minutes', 'America/Chicago', 'confirmed', 'busy', v_u2) RETURNING id INTO e10;

  -- Next week events
  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Sprint Retrospective', 'What went well, what to improve', now()::date + interval '7 days 10 hours', now()::date + interval '7 days 11 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e11;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Board Meeting', 'Quarterly board update', now()::date + interval '8 days 9 hours', now()::date + interval '8 days 11 hours', 'America/Chicago', 'tentative', 'busy', v_u1) RETURNING id INTO e12;

  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal2, v_org, 'Lunch with Team', now()::date + interval '8 days 12 hours', now()::date + interval '8 days 13 hours', 'America/Chicago', 'confirmed', 'free', v_u2) RETURNING id INTO e13;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'UX Workshop', 'User testing results review', now()::date + interval '9 days 14 hours', now()::date + interval '9 days 16 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e14;

  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal2, v_org, 'Customer Success Call', now()::date + interval '9 days 15 hours', now()::date + interval '9 days 15 hours 30 minutes', 'America/Chicago', 'confirmed', 'busy', v_u2) RETURNING id INTO e15;

  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Architecture Review', now()::date + interval '10 days 10 hours', now()::date + interval '10 days 11 hours 30 minutes', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e16;

  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal2, v_org, 'Sales Pipeline Review', now()::date + interval '10 days 14 hours', now()::date + interval '10 days 15 hours', 'America/Chicago', 'confirmed', 'busy', v_u2) RETURNING id INTO e17;

  INSERT INTO book_events (calendar_id, organization_id, title, description, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Demo Day', 'Show sprint deliverables to stakeholders', now()::date + interval '11 days 13 hours', now()::date + interval '11 days 14 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e18;

  -- Past events
  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, timezone, status, visibility, created_by)
  VALUES (cal1, v_org, 'Kickoff Meeting', now()::date - interval '3 days 10 hours' + interval '10 hours', now()::date - interval '3 days' + interval '11 hours', 'America/Chicago', 'confirmed', 'busy', v_u1) RETURNING id INTO e19;

  INSERT INTO book_events (calendar_id, organization_id, title, start_at, end_at, timezone, status, visibility, booking_page_id, booked_by_name, booked_by_email, created_by)
  VALUES (cal1, v_org, '30-Minute Intro Call with John Doe', now()::date - interval '1 day' + interval '14 hours', now()::date - interval '1 day' + interval '14 hours 30 minutes', 'America/Chicago', 'confirmed', 'busy', bp1, 'John Doe', 'john@example.com', v_u1) RETURNING id INTO e20;

  -- ══════════════════════════════════════════════════════════════
  -- 5. ATTENDEES (for select events)
  -- ══════════════════════════════════════════════════════════════

  -- Sprint Planning attendees
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status, is_organizer)
  VALUES (e2, v_u1, 'eddie@bigblueceiling.com', 'Eddie', 'accepted', true);
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status)
  VALUES (e2, v_u2, 'sarah@bigblueceiling.com', 'Sarah', 'accepted');

  -- Design Review attendees
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status, is_organizer)
  VALUES (e4, v_u1, 'eddie@bigblueceiling.com', 'Eddie', 'accepted', true);
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status)
  VALUES (e4, v_u2, 'sarah@bigblueceiling.com', 'Sarah', 'tentative');

  -- 1:1 attendees
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status, is_organizer)
  VALUES (e5, v_u2, 'sarah@bigblueceiling.com', 'Sarah', 'accepted', true);
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status)
  VALUES (e5, v_u1, 'eddie@bigblueceiling.com', 'Eddie', 'accepted');

  -- Board Meeting with external attendee
  INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status, is_organizer)
  VALUES (e12, v_u1, 'eddie@bigblueceiling.com', 'Eddie', 'accepted', true);
  INSERT INTO book_event_attendees (event_id, email, name, response_status)
  VALUES (e12, 'investor@example.com', 'External Board Member', 'needs_action');

  RAISE NOTICE 'Book seed complete: 2 calendars, 20 events, 1 booking page, working hours for 2 users';
END $$;
