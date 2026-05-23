# BigBlueBam — Design Document v2 Addendum

## New Features & Enhancements

This addendum covers features identified through gap analysis against Linear, Jira, Asana, and common project management workflows. All features below extend the v1.0 design document.

---

## 28. Data Import

### 28.1 Jira Import

**Endpoint:** `POST /projects/:id/import/jira`

Accept a Jira CSV export file. Map columns:
- Summary → title
- Issue Type → label (create labels Bug, Story, Task, Epic automatically)
- Status → phase (map to closest: To Do, In Progress, Done, etc.)
- Priority → priority (Critical, High, Medium, Low mapping)
- Assignee → assignee (match by email, skip if not found)
- Story Points → story_points
- Sprint → sprint (create if not exists)
- Description → description
- Created → created_at
- Labels → labels

Return import summary: { imported: N, skipped: N, errors: [...] }

### 28.2 Trello Import

**Endpoint:** `POST /projects/:id/import/trello`

Accept Trello JSON export. Map:
- Lists → phases
- Cards → tasks (preserving list position)
- Card labels → labels (with colors)
- Card members → assignees
- Card comments → comments
- Card checklists → subtasks
- Card due dates → due_date

### 28.3 CSV Import

**Endpoint:** `POST /projects/:id/import/csv`

Accept generic CSV with configurable column mapping:
```json
{
  "file": "base64 CSV data",
  "mapping": {
    "title": "Summary",
    "priority": "Priority",
    "assignee_email": "Assignee",
    "phase": "Status",
    "story_points": "Points",
    "description": "Description",
    "due_date": "Due Date",
    "labels": "Labels"
  }
}
```

### 28.4 GitHub Issues Import

**Endpoint:** `POST /projects/:id/import/github`

Accept GitHub repo URL + personal access token:
- Issues → tasks
- Issue labels → labels
- Issue assignees → assignees (match by email)
- Issue comments → comments
- Issue milestones → sprints
- Open/closed → phase (To Do / Done)

---

## 29. Enhanced Reporting & Dashboards

### 29.1 Team Workload View

**Frontend route:** `/projects/:id/workload`

Horizontal bar chart showing tasks assigned per user:
- Grouped by user
- Colored by priority
- Shows story points total per user
- Highlights overloaded users (> average + 1 std dev)

### 29.2 Status Distribution

Pie/donut chart showing tasks by:
- Phase distribution
- Priority distribution
- State distribution
Selectable granularity: current sprint, all, date range.

### 29.3 Overdue Report

**API:** `GET /projects/:id/reports/overdue`

Lists all tasks past due_date, sorted by days overdue:
- Task human_id, title, assignee, due_date, days_overdue
- Grouped by severity (>7 days, >3 days, >1 day, today)

### 29.4 Time Tracking Summary

**API:** `GET /projects/:id/reports/time-tracking`

Aggregated time entries by user and by week:
- Total hours per user per week
- Comparison: estimated vs. logged
- Export as CSV

### 29.5 PDF Sprint Report

**API:** `POST /projects/:id/reports/sprint-pdf?sprint_id=`

Generate a PDF document containing:
- Sprint name, dates, goal
- Velocity vs. committed
- Completion rate
- Burndown chart (rendered as SVG → embedded)
- Carry-forward list
- Scope changes

Uses a simple HTML-to-PDF approach (render HTML template, convert via Puppeteer or html-pdf).

### 29.6 Dashboard Widgets

**Frontend route:** `/projects/:id/dashboard`

Configurable dashboard with draggable widgets:
- Velocity trend (line chart)
- Burndown (area chart)
- Task distribution (donut)
- Overdue tasks (count + list)
- Team workload (bar chart)
- Recent activity (feed)
- Sprint progress (progress bar)

---

## 30. Communication Integrations

### 30.1 Slack Integration

**Setup:** `POST /projects/:id/integrations/slack`

Incoming webhook URL + channel mapping:
- Notify on: task created, task moved to Review/Done, sprint started/completed, task overdue
- Message format: rich Slack blocks with task title, assignee, priority, link

### 30.2 Email Digest

**Worker job:** `email-digest` (scheduled via cron)

Daily/weekly summary email per user:
- Tasks assigned to you that changed
- New comments on your tasks
- Overdue tasks
- Sprint progress summary

Configurable frequency in notification preferences.

### 30.3 iCal Feed

**API:** `GET /projects/:id/calendar.ics`
**API:** `GET /me/calendar.ics`

Generate iCalendar feed of task due dates:
- Each task with a due_date becomes a VEVENT
- VTODO for tasks assigned to user
- Subscribable in Google Calendar, Outlook, Apple Calendar

---

## 31. Developer Workflow

### 31.1 Git Integration

**API:** `POST /webhooks/github` (incoming webhook)

When GitHub sends push/PR events:
- Parse commit messages for `#FRND-123` references
- Link commits to tasks (store in activity_log)
- On PR merge: auto-transition linked tasks to next phase
- Show linked PRs/commits in task detail sidebar

### 31.2 Branch Name Helper

**MCP tool:** `suggest_branch_name`

Given a task, suggest a git branch name:
- Format: `type/FRND-123-short-title`
- Type from labels: feature/, bugfix/, hotfix/

### 31.3 CI/CD Status

Store CI/CD run status on tasks via webhook:
- Show green/red/pending badge on task cards
- Link to CI run URL

---

## 32. Enhanced Core Features

### 32.1 Task Templates

**API:** `GET/POST /projects/:id/task-templates`

Save task configurations as templates:
- Title pattern, description, default labels, phase, priority, subtask list
- "Create from template" button in task creation dialog
- Useful for bug reports, feature requests, recurring tasks

### 32.2 Task Duplication

**API:** `POST /tasks/:id/duplicate`

Clone a task with all fields (new human_id, reset state):
- Optionally duplicate subtasks
- Button in task detail drawer

### 32.3 Recurring Tasks

**API:** `POST /projects/:id/recurring-tasks`

Schedule automatic task creation:
- Recurrence: daily, weekly, biweekly, monthly
- Template: title, description, labels, assignee, phase
- Worker job checks and creates on schedule

### 32.4 Task Dependencies Visualization

In timeline/Gantt view:
- Draw arrows between blocking/blocked-by tasks
- Highlight critical path
- Warn when moving dates would violate dependencies

### 32.5 Emoji Reactions on Comments

**API:** `POST /comments/:id/reactions`

Quick emoji reactions (thumbs up, heart, etc.) on comments:
- Store reaction type + user_id
- Display reaction counts under comments
- Toggle on/off

### 32.6 @Mention Autocomplete

In comment textarea and description:
- Type `@` to trigger user dropdown
- Type `#` to trigger task reference dropdown
- Mentions create notifications

### 32.7 Bulk Edit from List View

Select multiple rows in list view:
- Change priority, phase, assignee, sprint for all selected
- API: `POST /tasks/bulk` (already exists)

### 32.8 Saved Views / Custom Filters

**API:** `GET/POST /projects/:id/views`

Save filter + sort + view type combinations:
- Name: "My Critical Bugs", "Unassigned This Sprint"
- Shareable with team
- Pinned views appear in sidebar

---

## 33. Multi-Organization Support

### 33.1 Organization Memberships

Replace `users.org_id` FK with `organization_memberships` join table:

```sql
CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role varchar(50) NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, org_id)
);
```

### 33.2 Org Switcher UI

Dropdown in sidebar header showing user's orgs:
- Current org highlighted
- Switch changes the active context
- Session stores `active_org_id`

### 33.3 Guest Access

Invite external users with limited permissions:
- Can view assigned tasks only
- Cannot see other users' tasks or project settings
- Time-limited access tokens

---

## 34. PWA & Mobile

### 34.1 PWA Manifest

Add `manifest.json` for installable web app:
- App name, icons, theme color
- Start URL: /
- Display: standalone

### 34.2 Service Worker

Cache static assets for offline access:
- Offline board viewing (cached last fetch)
- Queue mutations when offline, sync on reconnect
- Show offline indicator

---

## 35. Security & Compliance

### 35.1 Audit Log Viewer

**Frontend route:** `/settings/audit-log`

Searchable, filterable view of all activity_log entries:
- Who did what, when
- Filter by user, action type, date range
- Export as CSV

### 35.2 GDPR Data Export

**API:** `POST /me/data-export`

Generate a ZIP of all user data:
- Profile info
- All tasks created/assigned
- All comments
- Time entries
- Activity log entries

### 35.3 Data Retention

**API:** `POST /org/settings/retention`

Configure auto-deletion of:
- Completed tasks older than N days
- Activity logs older than N months
- Archived projects after N days
