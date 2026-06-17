# Bam - Project Management

Bam is the flagship project management app in BigBlueBam: Kanban boards with
sprint-based task tracking, configurable per project, built for small-to-medium
teams.

## Key Features

- **Kanban board** with drag-and-drop task cards, configurable phase columns, and
  swimlanes by assignee, priority, or epic
- **Sprints** with carry-forward mechanics that route unfinished work to the next
  sprint, the backlog, or cancellation while preserving history for reporting
- **Rich tasks** with subtasks and multiple parents, start and due dates, story
  points, custom fields (seven types), comments with reactions and revision
  history, time entries, attachments, and a done-gate that blocks closing a task
  with open subtasks
- **Five views** - Board, List, Timeline (Gantt, driven by start and due dates),
  Calendar, and Workload - plus saved views that persist a filter, sort, swimlane,
  and view-type preset
- **My Work** showing only the tasks assigned to you across every project, grouped
  into Overdue, Due This Week, In Progress, and All My Tasks
- **Reports** for velocity, burndown, cumulative flow, cycle time, overdue,
  workload, time tracking, and status distribution
- **Import** from CSV, Trello, Jira, or GitHub Issues, and **export** to JSON or
  CSV, with an iCal feed for task due dates
- **Agent-ready** - nearly every board action is available as an MCP tool, so an
  AI agent can plan a sprint, create and move tasks, or run a report

## Integrations

Bam shares authentication and org context with every other BigBlueBam app.
Helpdesk tickets can spawn Bam tasks (a Helpdesk tab then appears on the task),
GitHub commits and pull requests link back to tasks, Slack receives sprint and
task notifications, tasks can be shared into Banter channels and deep-linked back
by human id, and task, sprint, epic, and comment changes emit events to Bolt for
automation. The command palette (Cmd+K) and Launchpad provide quick navigation
across the suite.

## Getting Started

After logging in, create your first project from the dashboard and pick a template
(kanban_standard, scrum, bug_tracking, or minimal) so phases and states arrive
seeded. Add tasks to the board, assign them to anyone in your org (assignment is
not limited to project members), and group them into a sprint. Invite teammates
through the People page. Use keyboard shortcuts (press ? for help, N to create a
task, Cmd+K for the command palette) to move fast. Sprint reports and project
dashboards give you visibility into velocity, burndown, and workload.
