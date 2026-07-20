# book MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `book_cancel_event` | Cancel a calendar event (sets status to cancelled). `id` accepts either a UUID or an event title. | `id` |
| `book_create_booking_page` | Create a public booking page (scheduling link). | `slug`, `title`, `duration_minutes` |
| `book_create_calendar` | Create a calendar in the caller's organization. | `color`, `calendar_type`, `timezone`, `project_id` |
| `book_create_connection` | Subscribe to an external calendar feed by .ics URL (the no-OAuth provider path). The feed is pulled into a Book calendar on creation-time sync and on the worker schedule. Google/Microsoft connections require operator OAuth credentials and are not created here. | `feed_url`, `calendar_id` |
| `book_create_event` | Create a calendar event with optional attendees. `calendar_id` accepts either a UUID or a calendar name (case-insensitive). Each attendee `user_id` accepts either a UUID or an email address. | `calendar_id`, `title`, `start_at`, `end_at`, `location`, `meeting_url`, `all_day`, `attendees`, `email`, `user_id` |
| `book_delete_booking_page` | Delete a public booking page (scheduling link). | `id` |
| `book_delete_calendar` | Delete a calendar. `id` accepts either a UUID or a calendar name (case-insensitive exact match). | `id` |
| `book_delete_connection` | Remove an external calendar connection (Google/Microsoft). | `id` |
| `book_find_meeting_time` | AI-assisted: find optimal meeting times for a set of attendees. Returns up to 3 suggested slots. Each entry in `user_ids` accepts either a UUID or an email address. | `user_ids`, `duration_minutes`, `start_date`, `end_date` |
| `book_find_meeting_time_for_users` | Find meeting-time slots across a mixed roster of humans and agents/service accounts. Agents/service accounts have no calendars; when respect_working_hours_for_humans_only is true (default) they are treated as unconditionally available and skipped from conflict detection. Each entry in user_ids accepts a UUID or an email address. Returns slots with per-attendee availability annotations so the caller can render "agent: always available" alongside the human conflict picture. | `user_ids`, `duration_minutes`, `window`, `since`, `until`, `respect_working_hours_for_humans_only`, `timezone` |
| `book_get_availability` | Get available time slots for a user in a date range. `user_id` accepts either a UUID or an email address. | `user_id`, `start_date`, `end_date` |
| `book_get_event` | Get a single calendar event by ID, including attendees and linked-entity context. | `id` |
| `book_get_team_availability` | Get available time slots for multiple users to find common free times. Each entry in `user_ids` accepts either a UUID or an email address. Fails cleanly if any input cannot be resolved. | `user_ids`, `start_date`, `end_date` |
| `book_get_timeline` | Get aggregated cross-product timeline with Book events, Bam tasks, sprints, and more. | `start_date`, `end_date` |
| `book_get_working_hours` | Get the caller's weekly working-hours schedule (per day-of-week availability windows). | none |
| `book_list_booking_pages` | List the caller's public booking pages (scheduling links). | none |
| `book_list_calendars` | List the caller's calendars, optionally filtered by calendar type (personal, team, project, booking). | `calendar_type` |
| `book_list_connections` | List the caller's external calendar connections (ICS feeds / Google / Microsoft) and their sync status. Tokens and feed URLs are never exposed. | none |
| `book_list_events` | List calendar events in a date range, optionally filtered by calendar IDs. | `start_after`, `start_before`, `calendar_ids`, `limit` |
| `book_rsvp_event` | Accept, decline, or mark tentative for a calendar event on behalf of the current user. `event_id` accepts either a UUID or an event title. | `event_id`, `response_status` |
| `book_set_working_hours` | Replace the caller's weekly working-hours schedule. `day_of_week` is 0 (Sunday) through 6 (Saturday); times are HH:MM or HH:MM:SS. This is a full replace — include every day you want available. | `hours`, `day_of_week`, `start_time`, `end_time`, `timezone`, `enabled` |
| `book_sync_connection` | Force an immediate sync of an existing external calendar connection. Returns the import result counts (imported/created/updated/removed). | `id` |
| `book_update_booking_page` | Update a public booking page. Provide only the fields to change. Set `enabled: false` to take a page offline without deleting it. | `id`, `slug`, `title`, `duration_minutes`, `buffer_before_min`, `buffer_after_min`, `max_advance_days`, `min_notice_hours`, `color`, `logo_url`, `confirmation_message`, `redirect_url`, `auto_create_bond_contact`, `auto_create_bam_task`, `bam_project_id`, `enabled` |
| `book_update_calendar` | Update a calendar's metadata. `id` accepts either a UUID or a calendar name (case-insensitive exact match). Provide only the fields to change. | `id`, `color`, `timezone` |
| `book_update_event` | Update an existing calendar event. `id` accepts either a UUID or an event title (case-insensitive exact or single fuzzy match within +/- 1 year of now). | `id`, `title`, `start_at`, `end_at`, `location`, `status` |
