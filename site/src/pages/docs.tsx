import { useState, useEffect } from 'react';
import {
  ChevronDown, ChevronRight, ArrowLeft, BookOpen, Zap,
  FileText, Server, Users, Rocket, HelpCircle,
  LayoutDashboard, MessageCircle, Handshake, Mail, DollarSign, ClipboardList,
  Calendar, BarChart3, Target, PenTool, Sparkles, Database, Clapperboard,
  Activity, Headset, Building2, Ruler, GitMerge, ShieldCheck, Flame, ShoppingCart, Castle,
} from 'lucide-react';
import docsCatalog from '../content/docs-catalog.generated.json';
import { MCP_TOOL_COUNT, APP_COUNT_WORDS } from '@/lib/facts';

/* ------------------------------------------------------------------ */
/*  MCP Tool Data                                                      */
/*                                                                     */
/*  The per-app tool catalog below is AUTO-GENERATED from the          */
/*  mcp-server tool source and committed as JSON. Do NOT hand-edit the */
/*  tool lists here. To refresh after adding an app or tool, run       */
/*  `pnpm docs:catalog` (or `pnpm docs:generate`); it rewrites         */
/*  site/src/content/docs-catalog.generated.json which this file       */
/*  imports. See scripts/docs/build-docs-catalog.mjs.                  */
/* ------------------------------------------------------------------ */

interface Tool {
  name: string;
  description: string;
}

interface ToolCategory {
  name: string;
  tools: Tool[];
}

interface ToolProduct {
  name: string;
  icon: React.ReactNode;
  color: string;
  categories: ToolCategory[];
}

/** One app entry in the generated catalog JSON. */
interface GeneratedProduct {
  id: string;
  name: string;
  description: string;
  toolCount: number;
  categories: ToolCategory[];
}

// Per-app presentation, keyed by LAUNCHPAD_CATALOG id (Bam is `b3`). Icons and
// colors mirror the Launchpad's own choices. Anything not mapped falls back to
// a neutral Server icon / zinc chip, so a newly-added app still renders.
const APP_ICON: Record<string, React.ReactNode> = {
  b3: <LayoutDashboard className="h-4 w-4" />,
  banter: <MessageCircle className="h-4 w-4" />,
  beacon: <BookOpen className="h-4 w-4" />,
  bond: <Handshake className="h-4 w-4" />,
  blast: <Mail className="h-4 w-4" />,
  bill: <DollarSign className="h-4 w-4" />,
  blank: <ClipboardList className="h-4 w-4" />,
  book: <Calendar className="h-4 w-4" />,
  bench: <BarChart3 className="h-4 w-4" />,
  brief: <FileText className="h-4 w-4" />,
  bolt: <Zap className="h-4 w-4" />,
  bearing: <Target className="h-4 w-4" />,
  board: <PenTool className="h-4 w-4" />,
  blueprint: <Sparkles className="h-4 w-4" />,
  bin: <Database className="h-4 w-4" />,
  bay: <Clapperboard className="h-4 w-4" />,
  blip: <Activity className="h-4 w-4" />,
  helpdesk: <Headset className="h-4 w-4" />,
  bureau: <Building2 className="h-4 w-4" />,
  basis: <Ruler className="h-4 w-4" />,
  braid: <GitMerge className="h-4 w-4" />,
  bulwark: <ShieldCheck className="h-4 w-4" />,
  burn: <Flame className="h-4 w-4" />,
  bursar: <ShoppingCart className="h-4 w-4" />,
  bastion: <Castle className="h-4 w-4" />,
};

const APP_COLOR: Record<string, string> = {
  b3: 'bg-primary-100 text-primary-700',
  banter: 'bg-violet-100 text-violet-700',
  beacon: 'bg-emerald-100 text-emerald-700',
  bond: 'bg-cyan-100 text-cyan-700',
  blast: 'bg-red-100 text-red-700',
  bill: 'bg-green-100 text-green-700',
  blank: 'bg-purple-100 text-purple-700',
  book: 'bg-blue-100 text-blue-700',
  bench: 'bg-indigo-100 text-indigo-700',
  brief: 'bg-amber-100 text-amber-700',
  bolt: 'bg-orange-100 text-orange-700',
  bearing: 'bg-teal-100 text-teal-700',
  board: 'bg-indigo-100 text-indigo-700',
  blueprint: 'bg-sky-100 text-sky-700',
  bin: 'bg-sky-100 text-sky-700',
  bay: 'bg-pink-100 text-pink-700',
  blip: 'bg-cyan-100 text-cyan-700',
  helpdesk: 'bg-rose-100 text-rose-700',
  bureau: 'bg-slate-100 text-slate-700',
  basis: 'bg-indigo-100 text-indigo-700',
  braid: 'bg-indigo-100 text-indigo-700',
  bulwark: 'bg-blue-100 text-blue-700',
  burn: 'bg-orange-100 text-orange-700',
  bursar: 'bg-teal-100 text-teal-700',
  bastion: 'bg-stone-100 text-stone-700',
};

// Build the render model from the committed, auto-generated catalog. Each
// generated product carries its id/name/description/categories; we attach the
// presentational icon + color here. Adding an app requires no change to this
// file: re-run `pnpm docs:catalog` and the new app flows through.
const allProducts: ToolProduct[] = (docsCatalog as GeneratedProduct[]).map((p) => ({
  name: p.name,
  icon: APP_ICON[p.id] ?? <Server className="h-4 w-4" />,
  color: APP_COLOR[p.id] ?? "bg-zinc-100 text-zinc-700",
  categories: p.categories,
}));

function getTotalTools(product: ToolProduct): number {
  return product.categories.reduce((sum, cat) => sum + cat.tools.length, 0);
}

/* ------------------------------------------------------------------ */
/*  API Endpoint Data                                                  */
/* ------------------------------------------------------------------ */

interface Endpoint {
  method: string;
  path: string;
  description: string;
}

interface EndpointGroup {
  name: string;
  endpoints: Endpoint[];
}

interface ApiService {
  name: string;
  baseUrl: string;
  description: string;
  color: string;
  groups: EndpointGroup[];
}

const bamApi: ApiService = {
  name: 'Bam API',
  baseUrl: '/b3/api',
  description: 'Core project management API -- tasks, sprints, boards, reports, and team management.',
  color: 'bg-primary-100 text-primary-700',
  groups: [
    {
      name: 'Authentication',
      endpoints: [
        { method: 'POST', path: '/auth/login', description: 'Authenticate with email and password, returns session cookie' },
        { method: 'POST', path: '/auth/logout', description: 'Invalidate the current session' },
        { method: 'GET', path: '/auth/me', description: 'Get the authenticated user profile and active org' },
        { method: 'PATCH', path: '/auth/me', description: 'Update the authenticated user profile fields' },
        { method: 'POST', path: '/auth/change-password', description: 'Change the current user password' },
        { method: 'POST', path: '/auth/verify-email', description: 'Verify email address with token' },
        { method: 'POST', path: '/auth/resend-verification', description: 'Resend email verification link' },
      ],
    },
    {
      name: 'Tasks',
      endpoints: [
        { method: 'GET', path: '/tasks', description: 'List and filter tasks with cursor-based pagination' },
        { method: 'POST', path: '/tasks', description: 'Create a new task in a project' },
        { method: 'GET', path: '/tasks/:id', description: 'Get a single task with full details' },
        { method: 'PATCH', path: '/tasks/:id', description: 'Update task fields (title, description, assignee, priority, etc.)' },
        { method: 'DELETE', path: '/tasks/:id', description: 'Delete a task and its subtasks' },
        { method: 'POST', path: '/tasks/:id/move', description: 'Move a task to a different phase and/or position' },
        { method: 'POST', path: '/tasks/:id/duplicate', description: 'Duplicate a task, optionally with subtasks' },
        { method: 'POST', path: '/tasks/bulk', description: 'Bulk update, move, or delete multiple tasks' },
        { method: 'GET', path: '/tasks/me', description: 'Get tasks assigned to the current user across all projects' },
      ],
    },
    {
      name: 'Sprints',
      endpoints: [
        { method: 'GET', path: '/projects/:id/sprints', description: 'List all sprints for a project' },
        { method: 'POST', path: '/projects/:id/sprints', description: 'Create a new sprint' },
        { method: 'GET', path: '/sprints/:id', description: 'Get sprint details including assigned tasks' },
        { method: 'PATCH', path: '/sprints/:id', description: 'Update sprint name, dates, or goal' },
        { method: 'POST', path: '/sprints/:id/start', description: 'Start a planned sprint' },
        { method: 'POST', path: '/sprints/:id/complete', description: 'Complete a sprint and handle carry-forward' },
      ],
    },
    {
      name: 'Projects',
      endpoints: [
        { method: 'GET', path: '/projects', description: 'List all projects the user has access to' },
        { method: 'POST', path: '/projects', description: 'Create a new project in the active org' },
        { method: 'GET', path: '/projects/:id', description: 'Get project details including phases and settings' },
        { method: 'PATCH', path: '/projects/:id', description: 'Update project name, description, or settings' },
        { method: 'DELETE', path: '/projects/:id', description: 'Delete a project and all associated data' },
        { method: 'GET', path: '/projects/:id/board', description: 'Get the full board state with phases and tasks' },
      ],
    },
    {
      name: 'Phases',
      endpoints: [
        { method: 'GET', path: '/projects/:id/phases', description: 'List all phases (columns) for a project' },
        { method: 'POST', path: '/projects/:id/phases', description: 'Create a new phase on the board' },
        { method: 'PATCH', path: '/phases/:id', description: 'Update phase name, WIP limit, or settings' },
        { method: 'DELETE', path: '/phases/:id', description: 'Delete a phase (must be empty)' },
        { method: 'POST', path: '/projects/:id/phases/reorder', description: 'Reorder board columns' },
      ],
    },
    {
      name: 'Comments',
      endpoints: [
        { method: 'GET', path: '/tasks/:id/comments', description: 'List comments on a task (threaded)' },
        { method: 'POST', path: '/tasks/:id/comments', description: 'Add a comment to a task' },
        { method: 'PATCH', path: '/comments/:id', description: 'Edit a comment body' },
        { method: 'DELETE', path: '/comments/:id', description: 'Delete a comment' },
      ],
    },
    {
      name: 'Reactions',
      endpoints: [
        { method: 'POST', path: '/comments/:id/reactions', description: 'Add or toggle a reaction emoji on a comment' },
        { method: 'DELETE', path: '/comments/:id/reactions/:emoji', description: 'Remove a reaction from a comment' },
      ],
    },
    {
      name: 'Labels',
      endpoints: [
        { method: 'GET', path: '/projects/:id/labels', description: 'List all labels in a project' },
        { method: 'POST', path: '/projects/:id/labels', description: 'Create a new label' },
        { method: 'PATCH', path: '/labels/:id', description: 'Update label name or color' },
        { method: 'DELETE', path: '/labels/:id', description: 'Delete a label' },
      ],
    },
    {
      name: 'Epics',
      endpoints: [
        { method: 'GET', path: '/projects/:id/epics', description: 'List epics in a project' },
        { method: 'POST', path: '/projects/:id/epics', description: 'Create a new epic' },
        { method: 'PATCH', path: '/epics/:id', description: 'Update an epic' },
        { method: 'DELETE', path: '/epics/:id', description: 'Delete an epic' },
      ],
    },
    {
      name: 'Members',
      endpoints: [
        { method: 'GET', path: '/projects/:id/members', description: 'List project members with roles' },
        { method: 'POST', path: '/projects/:id/members', description: 'Add a member to a project' },
        { method: 'PATCH', path: '/projects/:id/members/:userId', description: 'Update a member role' },
        { method: 'DELETE', path: '/projects/:id/members/:userId', description: 'Remove a member from a project' },
        { method: 'GET', path: '/orgs/members', description: 'List all members of the active organization' },
      ],
    },
    {
      name: 'Reports',
      endpoints: [
        { method: 'GET', path: '/projects/:id/reports/velocity', description: 'Velocity report across recent sprints' },
        { method: 'GET', path: '/projects/:id/reports/burndown', description: 'Burndown chart data for a sprint' },
        { method: 'GET', path: '/projects/:id/reports/cumulative-flow', description: 'Cumulative flow diagram data' },
        { method: 'GET', path: '/projects/:id/reports/overdue', description: 'Overdue tasks report' },
        { method: 'GET', path: '/projects/:id/reports/workload', description: 'Workload distribution per member' },
        { method: 'GET', path: '/projects/:id/reports/status-distribution', description: 'Task counts per phase/status' },
        { method: 'GET', path: '/projects/:id/reports/cycle-time', description: 'Cycle time metrics for completed tasks' },
        { method: 'GET', path: '/projects/:id/reports/time-tracking', description: 'Time entries per user' },
      ],
    },
    {
      name: 'Time Entries',
      endpoints: [
        { method: 'GET', path: '/tasks/:id/time-entries', description: 'List time entries for a task' },
        { method: 'POST', path: '/tasks/:id/time-entries', description: 'Log time spent on a task' },
        { method: 'PATCH', path: '/time-entries/:id', description: 'Update a time entry' },
        { method: 'DELETE', path: '/time-entries/:id', description: 'Delete a time entry' },
      ],
    },
    {
      name: 'Custom Fields',
      endpoints: [
        { method: 'GET', path: '/projects/:id/custom-fields', description: 'List custom field definitions' },
        { method: 'POST', path: '/projects/:id/custom-fields', description: 'Create a custom field definition' },
        { method: 'PATCH', path: '/custom-fields/:id', description: 'Update a custom field' },
        { method: 'DELETE', path: '/custom-fields/:id', description: 'Delete a custom field definition' },
      ],
    },
    {
      name: 'Templates',
      endpoints: [
        { method: 'GET', path: '/projects/:id/templates', description: 'List task templates for a project' },
        { method: 'POST', path: '/projects/:id/templates', description: 'Create a task template' },
        { method: 'POST', path: '/templates/:id/create-task', description: 'Create a task from a template' },
        { method: 'DELETE', path: '/templates/:id', description: 'Delete a template' },
      ],
    },
    {
      name: 'Saved Views',
      endpoints: [
        { method: 'GET', path: '/projects/:id/views', description: 'List saved views for a project' },
        { method: 'POST', path: '/projects/:id/views', description: 'Save a filter/sort/swimlane view configuration' },
        { method: 'PATCH', path: '/views/:id', description: 'Update a saved view' },
        { method: 'DELETE', path: '/views/:id', description: 'Delete a saved view' },
      ],
    },
    {
      name: 'Attachments',
      endpoints: [
        { method: 'GET', path: '/tasks/:id/attachments', description: 'List attachments on a task' },
        { method: 'POST', path: '/tasks/:id/attachments', description: 'Upload an attachment to a task' },
        { method: 'DELETE', path: '/attachments/:id', description: 'Delete an attachment' },
      ],
    },
    {
      name: 'Activity Log',
      endpoints: [
        { method: 'GET', path: '/tasks/:id/activity', description: 'Get the activity log for a task' },
        { method: 'GET', path: '/projects/:id/activity', description: 'Get the activity log for a project' },
      ],
    },
    {
      name: 'Notifications',
      endpoints: [
        { method: 'GET', path: '/notifications', description: 'Get the notification feed (paginated)' },
        { method: 'POST', path: '/notifications/:id/read', description: 'Mark a notification as read' },
        { method: 'POST', path: '/notifications/read-all', description: 'Mark all notifications as read' },
      ],
    },
    {
      name: 'API Keys',
      endpoints: [
        { method: 'GET', path: '/api-keys', description: 'List API keys for the current user' },
        { method: 'POST', path: '/api-keys', description: 'Create a new API key (bbam_ prefixed)' },
        { method: 'DELETE', path: '/api-keys/:id', description: 'Revoke an API key' },
      ],
    },
    {
      name: 'LLM Providers',
      endpoints: [
        { method: 'GET', path: '/llm-providers', description: 'List configured LLM providers' },
        { method: 'POST', path: '/llm-providers', description: 'Add a new LLM provider configuration' },
        { method: 'GET', path: '/llm-providers/:id', description: 'Get provider details' },
        { method: 'PATCH', path: '/llm-providers/:id', description: 'Update provider settings' },
        { method: 'DELETE', path: '/llm-providers/:id', description: 'Remove a provider' },
        { method: 'GET', path: '/llm-providers/resolve', description: 'Resolve the effective provider for a given capability' },
        { method: 'POST', path: '/llm-providers/:id/test', description: 'Test provider connectivity and model availability' },
      ],
    },
    {
      name: 'Imports & Integrations',
      endpoints: [
        { method: 'POST', path: '/import/csv', description: 'Import tasks from CSV' },
        { method: 'POST', path: '/import/trello', description: 'Import a Trello board' },
        { method: 'POST', path: '/import/jira', description: 'Import from Jira' },
        { method: 'POST', path: '/import/github', description: 'Import GitHub issues' },
        { method: 'POST', path: '/projects/:id/github/connect', description: 'Connect a GitHub repo to a project' },
        { method: 'DELETE', path: '/projects/:id/github/disconnect', description: 'Disconnect GitHub integration' },
        { method: 'POST', path: '/projects/:id/slack/connect', description: 'Connect a Slack webhook to a project' },
        { method: 'POST', path: '/projects/:id/slack/test', description: 'Send a test message to Slack' },
      ],
    },
    {
      name: 'Export & iCal',
      endpoints: [
        { method: 'POST', path: '/export/csv', description: 'Export tasks as CSV' },
        { method: 'GET', path: '/ical/:token', description: 'iCal calendar feed of tasks with due dates' },
      ],
    },
    {
      name: 'Organizations',
      endpoints: [
        { method: 'GET', path: '/orgs', description: 'List organizations the user belongs to' },
        { method: 'POST', path: '/orgs', description: 'Create a new organization' },
        { method: 'PATCH', path: '/orgs/:id', description: 'Update organization settings' },
        { method: 'POST', path: '/orgs/switch', description: 'Switch the active organization for the session' },
      ],
    },
    {
      name: 'Platform & SuperUser',
      endpoints: [
        { method: 'GET', path: '/public/config', description: 'Get public platform configuration (no auth)' },
        { method: 'GET', path: '/platform/settings', description: 'Get platform settings (SuperUser)' },
        { method: 'PATCH', path: '/platform/settings', description: 'Update platform settings (SuperUser)' },
        { method: 'GET', path: '/superuser/users', description: 'List all users across all orgs (SuperUser)' },
        { method: 'PATCH', path: '/superuser/users/:id', description: 'Update any user account (SuperUser)' },
      ],
    },
  ],
};

const banterApi: ApiService = {
  name: 'Banter API',
  baseUrl: '/banter/api',
  description: 'Real-time team messaging -- channels, DMs, threads, reactions, voice/video calls, and search.',
  color: 'bg-violet-100 text-violet-700',
  groups: [
    {
      name: 'Channels',
      endpoints: [
        { method: 'GET', path: '/channels', description: 'List channels the user has access to' },
        { method: 'POST', path: '/channels', description: 'Create a new channel (public or private)' },
        { method: 'GET', path: '/channels/:id', description: 'Get channel details including topic and member count' },
        { method: 'PATCH', path: '/channels/:id', description: 'Update channel name, description, or topic' },
        { method: 'DELETE', path: '/channels/:id', description: 'Delete a channel (owner or admin)' },
        { method: 'POST', path: '/channels/:id/archive', description: 'Archive a channel (reversible)' },
        { method: 'POST', path: '/channels/:id/join', description: 'Join a public channel' },
        { method: 'POST', path: '/channels/:id/leave', description: 'Leave a channel' },
        { method: 'GET', path: '/channels/:id/members', description: 'List channel members' },
        { method: 'POST', path: '/channels/:id/members', description: 'Add members to a channel' },
        { method: 'DELETE', path: '/channels/:id/members/:userId', description: 'Remove a member from a channel' },
        { method: 'GET', path: '/channels/browse', description: 'Browse all joinable channels' },
      ],
    },
    {
      name: 'Messages',
      endpoints: [
        { method: 'GET', path: '/channels/:id/messages', description: 'List messages in a channel (cursor-paginated)' },
        { method: 'POST', path: '/channels/:id/messages', description: 'Post a new message' },
        { method: 'GET', path: '/messages/:id', description: 'Get a single message by ID' },
        { method: 'PATCH', path: '/messages/:id', description: 'Edit a message' },
        { method: 'DELETE', path: '/messages/:id', description: 'Delete a message' },
      ],
    },
    {
      name: 'Threads',
      endpoints: [
        { method: 'GET', path: '/messages/:id/replies', description: 'List replies in a message thread' },
        { method: 'POST', path: '/messages/:id/replies', description: 'Post a reply in a thread' },
      ],
    },
    {
      name: 'Reactions',
      endpoints: [
        { method: 'POST', path: '/messages/:id/reactions', description: 'Add or toggle a reaction on a message' },
        { method: 'DELETE', path: '/messages/:id/reactions/:emoji', description: 'Remove a reaction' },
      ],
    },
    {
      name: 'Pins & Bookmarks',
      endpoints: [
        { method: 'GET', path: '/channels/:id/pins', description: 'List pinned messages in a channel' },
        { method: 'POST', path: '/messages/:id/pin', description: 'Pin a message' },
        { method: 'DELETE', path: '/messages/:id/pin', description: 'Unpin a message' },
        { method: 'GET', path: '/bookmarks', description: 'List user bookmarks' },
        { method: 'POST', path: '/messages/:id/bookmark', description: 'Bookmark a message' },
        { method: 'DELETE', path: '/bookmarks/:id', description: 'Remove a bookmark' },
      ],
    },
    {
      name: 'Direct Messages',
      endpoints: [
        { method: 'GET', path: '/dm', description: 'List DM conversations' },
        { method: 'POST', path: '/dm', description: 'Start or resume a DM with a user' },
        { method: 'POST', path: '/dm/group', description: 'Create a group DM' },
      ],
    },
    {
      name: 'User Groups',
      endpoints: [
        { method: 'GET', path: '/user-groups', description: 'List all user groups (@-handles)' },
        { method: 'POST', path: '/user-groups', description: 'Create a user group' },
        { method: 'PATCH', path: '/user-groups/:id', description: 'Update a user group' },
        { method: 'POST', path: '/user-groups/:id/members', description: 'Add members to a group' },
        { method: 'DELETE', path: '/user-groups/:id/members/:userId', description: 'Remove a member from a group' },
      ],
    },
    {
      name: 'Calls',
      endpoints: [
        { method: 'POST', path: '/channels/:id/calls', description: 'Start a voice/video call in a channel' },
        { method: 'POST', path: '/calls/:id/join', description: 'Join an active call' },
        { method: 'POST', path: '/calls/:id/leave', description: 'Leave a call' },
        { method: 'POST', path: '/calls/:id/end', description: 'End a call (host or admin)' },
        { method: 'GET', path: '/calls/:id', description: 'Get call details and participants' },
        { method: 'GET', path: '/channels/:id/calls', description: 'List calls in a channel' },
        { method: 'GET', path: '/calls/:id/transcript', description: 'Get the transcript for a call' },
      ],
    },
    {
      name: 'Search',
      endpoints: [
        { method: 'GET', path: '/search', description: 'Search messages across all accessible channels' },
        { method: 'GET', path: '/search/transcripts', description: 'Search call transcripts' },
      ],
    },
    {
      name: 'Preferences',
      endpoints: [
        { method: 'GET', path: '/preferences', description: 'Get notification and theme preferences' },
        { method: 'PATCH', path: '/preferences', description: 'Update preferences' },
        { method: 'GET', path: '/unread', description: 'Get unread message summary' },
        { method: 'POST', path: '/presence', description: 'Set presence status (online, away, dnd, offline)' },
      ],
    },
    {
      name: 'Files & Admin',
      endpoints: [
        { method: 'POST', path: '/files/upload', description: 'Upload a file to attach to a message' },
        { method: 'GET', path: '/admin/settings', description: 'Get workspace Banter settings (admin)' },
        { method: 'PATCH', path: '/admin/settings', description: 'Update workspace Banter settings (admin)' },
      ],
    },
  ],
};

const beaconApi: ApiService = {
  name: 'Beacon API',
  baseUrl: '/beacon/api/v1',
  description: 'Knowledge base with semantic search, verification lifecycle, governance policies, and a knowledge graph.',
  color: 'bg-amber-100 text-amber-700',
  groups: [
    {
      name: 'Beacons',
      endpoints: [
        { method: 'GET', path: '/beacons', description: 'List beacons with filters (status, tag, author, search)' },
        { method: 'POST', path: '/beacons', description: 'Create a new beacon (draft)' },
        { method: 'GET', path: '/beacons/:id', description: 'Get a beacon by ID or slug' },
        { method: 'PATCH', path: '/beacons/:id', description: 'Update a beacon (creates a new version)' },
        { method: 'DELETE', path: '/beacons/:id', description: 'Retire (soft-delete) a beacon' },
        { method: 'POST', path: '/beacons/:id/publish', description: 'Transition a beacon from Draft to Active' },
        { method: 'POST', path: '/beacons/:id/verify', description: 'Record a verification event' },
        { method: 'POST', path: '/beacons/:id/challenge', description: 'Flag a beacon for review' },
        { method: 'POST', path: '/beacons/:id/restore', description: 'Restore an archived beacon' },
      ],
    },
    {
      name: 'Versions',
      endpoints: [
        { method: 'GET', path: '/beacons/:id/versions', description: 'List version history for a beacon' },
        { method: 'GET', path: '/beacons/:id/versions/:version', description: 'Get a specific version' },
      ],
    },
    {
      name: 'Tags',
      endpoints: [
        { method: 'GET', path: '/tags', description: 'List all tags with usage counts' },
        { method: 'POST', path: '/beacons/:id/tags', description: 'Add tags to a beacon' },
        { method: 'DELETE', path: '/beacons/:id/tags/:tag', description: 'Remove a tag from a beacon' },
      ],
    },
    {
      name: 'Links',
      endpoints: [
        { method: 'POST', path: '/beacons/:id/links', description: 'Create a typed link between two beacons' },
        { method: 'DELETE', path: '/beacons/:id/links/:linkId', description: 'Remove a link' },
      ],
    },
    {
      name: 'Search',
      endpoints: [
        { method: 'GET', path: '/search', description: 'Hybrid semantic + keyword + graph search' },
        { method: 'GET', path: '/suggest', description: 'Typeahead suggestions from title/tag index' },
        { method: 'GET', path: '/search/context', description: 'Structured retrieval for agent consumption' },
      ],
    },
    {
      name: 'Graph',
      endpoints: [
        { method: 'GET', path: '/graph/neighbors/:id', description: 'Get nodes and edges within N hops' },
        { method: 'GET', path: '/graph/hubs', description: 'Get the most-connected beacon nodes' },
        { method: 'GET', path: '/graph/recent', description: 'Get recently modified/verified beacons' },
      ],
    },
    {
      name: 'Policies',
      endpoints: [
        { method: 'GET', path: '/policies', description: 'Get the effective governance policy' },
        { method: 'PUT', path: '/policies', description: 'Set or update a governance policy' },
        { method: 'GET', path: '/policies/resolve', description: 'Preview the merged effective policy' },
      ],
    },
    {
      name: 'Saved Queries',
      endpoints: [
        { method: 'GET', path: '/queries', description: 'List saved search queries' },
        { method: 'POST', path: '/queries', description: 'Save a named query' },
        { method: 'GET', path: '/queries/:id', description: 'Get a saved query' },
        { method: 'DELETE', path: '/queries/:id', description: 'Delete a saved query' },
      ],
    },
  ],
};

const briefApi: ApiService = {
  name: 'Brief API',
  baseUrl: '/brief/api/v1',
  description: 'Collaborative document editor -- documents, folders, versions, comments, templates, and cross-product linking.',
  color: 'bg-emerald-100 text-emerald-700',
  groups: [
    {
      name: 'Documents',
      endpoints: [
        { method: 'GET', path: '/documents', description: 'List documents with filters and pagination' },
        { method: 'POST', path: '/documents', description: 'Create a new document' },
        { method: 'GET', path: '/documents/:id', description: 'Get a document by ID or slug' },
        { method: 'PATCH', path: '/documents/:id', description: 'Update document metadata (title, status, etc.)' },
        { method: 'PUT', path: '/documents/:id/content', description: 'Replace the full document content' },
        { method: 'POST', path: '/documents/:id/content/append', description: 'Append content to the end' },
        { method: 'DELETE', path: '/documents/:id', description: 'Archive a document (soft-delete)' },
        { method: 'POST', path: '/documents/:id/restore', description: 'Restore an archived document' },
        { method: 'POST', path: '/documents/:id/duplicate', description: 'Duplicate a document' },
        { method: 'GET', path: '/search', description: 'Search documents by keyword or semantic similarity' },
      ],
    },
    {
      name: 'Folders',
      endpoints: [
        { method: 'GET', path: '/folders', description: 'List folders in a project' },
        { method: 'POST', path: '/folders', description: 'Create a folder' },
        { method: 'PATCH', path: '/folders/:id', description: 'Rename or move a folder' },
        { method: 'DELETE', path: '/folders/:id', description: 'Delete a folder' },
      ],
    },
    {
      name: 'Versions',
      endpoints: [
        { method: 'GET', path: '/documents/:id/versions', description: 'List version history' },
        { method: 'GET', path: '/documents/:id/versions/:version', description: 'Get a specific version' },
        { method: 'POST', path: '/documents/:id/versions/:version/restore', description: 'Restore to a previous version' },
      ],
    },
    {
      name: 'Comments',
      endpoints: [
        { method: 'GET', path: '/documents/:id/comments', description: 'List inline comments on a document' },
        { method: 'POST', path: '/documents/:id/comments', description: 'Add an inline comment' },
        { method: 'POST', path: '/comments/:id/resolve', description: 'Toggle resolved state' },
      ],
    },
    {
      name: 'Embeds & Links',
      endpoints: [
        { method: 'GET', path: '/documents/:id/embeds', description: 'List embeds in a document' },
        { method: 'POST', path: '/documents/:id/embeds', description: 'Create an embed (task, beacon, etc.)' },
        { method: 'POST', path: '/documents/:id/links', description: 'Link a document to a task or beacon' },
        { method: 'DELETE', path: '/documents/:id/links/:linkId', description: 'Remove a link' },
      ],
    },
    {
      name: 'Collaborators',
      endpoints: [
        { method: 'GET', path: '/documents/:id/collaborators', description: 'List document collaborators' },
        { method: 'POST', path: '/documents/:id/collaborators', description: 'Add a collaborator' },
        { method: 'DELETE', path: '/documents/:id/collaborators/:userId', description: 'Remove a collaborator' },
      ],
    },
    {
      name: 'Templates',
      endpoints: [
        { method: 'GET', path: '/templates', description: 'List document templates' },
        { method: 'POST', path: '/templates', description: 'Create a template from a document' },
        { method: 'POST', path: '/templates/:id/create', description: 'Create a new document from a template' },
        { method: 'DELETE', path: '/templates/:id', description: 'Delete a template' },
      ],
    },
    {
      name: 'Integration',
      endpoints: [
        { method: 'POST', path: '/documents/:id/promote-to-beacon', description: 'Graduate a document to a Beacon article' },
      ],
    },
  ],
};

const boltApi: ApiService = {
  name: 'Bolt API',
  baseUrl: '/bolt/api/v1',
  description: 'Workflow automation engine -- WHEN/IF/THEN automations that trigger MCP tool actions on events.',
  color: 'bg-rose-100 text-rose-700',
  groups: [
    {
      name: 'Automations',
      endpoints: [
        { method: 'GET', path: '/automations', description: 'List automations with optional filters' },
        { method: 'POST', path: '/automations', description: 'Create a new automation (trigger + conditions + actions)' },
        { method: 'GET', path: '/automations/:id', description: 'Get an automation with its full definition' },
        { method: 'PATCH', path: '/automations/:id', description: 'Update an automation' },
        { method: 'DELETE', path: '/automations/:id', description: 'Delete an automation' },
        { method: 'POST', path: '/automations/:id/enable', description: 'Enable a disabled automation' },
        { method: 'POST', path: '/automations/:id/disable', description: 'Disable an automation' },
        { method: 'POST', path: '/automations/:id/test', description: 'Test-fire an automation with a simulated event' },
      ],
    },
    {
      name: 'Executions',
      endpoints: [
        { method: 'GET', path: '/automations/:id/executions', description: 'List execution history' },
        { method: 'GET', path: '/executions/:id', description: 'Get detailed execution info (steps, timing, errors)' },
      ],
    },
    {
      name: 'Events & Discovery',
      endpoints: [
        { method: 'GET', path: '/events', description: 'List available trigger events by source (bam, banter, beacon, etc.)' },
        { method: 'GET', path: '/actions', description: 'List MCP tools available as automation actions' },
      ],
    },
    {
      name: 'Templates',
      endpoints: [
        { method: 'GET', path: '/templates', description: 'List pre-built automation templates' },
        { method: 'POST', path: '/templates/:id/create', description: 'Create an automation from a template' },
      ],
    },
    {
      name: 'AI Assist',
      endpoints: [
        { method: 'POST', path: '/ai-assist', description: 'Describe an automation in natural language and get a suggested definition' },
      ],
    },
  ],
};

const helpdeskApi: ApiService = {
  name: 'Helpdesk API',
  baseUrl: '/helpdesk/api',
  description: 'Customer support portal -- ticket submission, agent responses, AI triage, and settings management.',
  color: 'bg-sky-100 text-sky-700',
  groups: [
    {
      name: 'Authentication',
      endpoints: [
        { method: 'POST', path: '/auth/guest', description: 'Authenticate as a guest (customer submitting a ticket)' },
        { method: 'GET', path: '/auth/me', description: 'Get the current authenticated agent or guest' },
      ],
    },
    {
      name: 'Tickets',
      endpoints: [
        { method: 'GET', path: '/tickets', description: 'List tickets with filters (status, priority, assignee)' },
        { method: 'POST', path: '/tickets', description: 'Create a new support ticket' },
        { method: 'GET', path: '/tickets/:id', description: 'Get ticket details including messages' },
        { method: 'PATCH', path: '/tickets/:id', description: 'Update ticket status, priority, or assignee' },
      ],
    },
    {
      name: 'Messages',
      endpoints: [
        { method: 'GET', path: '/tickets/:id/messages', description: 'List messages on a ticket' },
        { method: 'POST', path: '/tickets/:id/messages', description: 'Post a reply (public or internal note)' },
      ],
    },
    {
      name: 'Settings',
      endpoints: [
        { method: 'GET', path: '/settings/public', description: 'Get public helpdesk settings (branding, hours)' },
        { method: 'GET', path: '/settings', description: 'Get full settings (admin)' },
        { method: 'PATCH', path: '/settings', description: 'Update settings (admin)' },
      ],
    },
    {
      name: 'AI Agent',
      endpoints: [
        { method: 'POST', path: '/agent/triage', description: 'AI-triage a ticket (suggest priority, category, assignee)' },
        { method: 'POST', path: '/agent/suggest-reply', description: 'AI-suggest a reply based on ticket context and knowledge base' },
      ],
    },
    {
      name: 'Uploads',
      endpoints: [
        { method: 'POST', path: '/upload', description: 'Upload an attachment to a ticket' },
      ],
    },
  ],
};

const bearingApi: ApiService = {
  name: 'Bearing API',
  baseUrl: '/bearing/api',
  description: 'Goals and OKR tracking -- periods, objectives, key results, progress tracking, and reports.',
  color: 'bg-indigo-100 text-indigo-700',
  groups: [
    {
      name: 'Periods',
      endpoints: [
        { method: 'GET', path: '/periods', description: 'List OKR periods with optional status and year filters' },
        { method: 'POST', path: '/periods', description: 'Create a new OKR period' },
        { method: 'GET', path: '/periods/:id', description: 'Get a period with aggregated goal stats' },
        { method: 'PATCH', path: '/periods/:id', description: 'Update period name, dates, or type' },
        { method: 'DELETE', path: '/periods/:id', description: 'Delete a period' },
        { method: 'POST', path: '/periods/:id/activate', description: 'Activate a planning period' },
        { method: 'POST', path: '/periods/:id/complete', description: 'Complete an active period' },
      ],
    },
    {
      name: 'Goals',
      endpoints: [
        { method: 'GET', path: '/goals', description: 'List goals with filters (period, scope, owner, status)' },
        { method: 'POST', path: '/goals', description: 'Create a new goal in a period' },
        { method: 'GET', path: '/goals/:id', description: 'Get a goal with its key results' },
        { method: 'PATCH', path: '/goals/:id', description: 'Update goal fields' },
        { method: 'DELETE', path: '/goals/:id', description: 'Delete a goal and its key results' },
        { method: 'POST', path: '/goals/:id/status', description: 'Override the computed goal status' },
        { method: 'GET', path: '/goals/:id/updates', description: 'List status updates for a goal' },
        { method: 'POST', path: '/goals/:id/updates', description: 'Post a status update on a goal' },
        { method: 'GET', path: '/goals/:id/watchers', description: 'List watchers subscribed to a goal' },
        { method: 'POST', path: '/goals/:id/watchers', description: 'Subscribe as a watcher on a goal' },
        { method: 'DELETE', path: '/goals/:id/watchers/:userId', description: 'Remove a watcher from a goal' },
        { method: 'GET', path: '/goals/:id/history', description: 'Get progress history snapshots for a goal' },
      ],
    },
    {
      name: 'Key Results',
      endpoints: [
        { method: 'GET', path: '/goals/:id/key-results', description: 'List key results for a goal' },
        { method: 'POST', path: '/goals/:id/key-results', description: 'Create a key result under a goal' },
        { method: 'GET', path: '/key-results/:id', description: 'Get a single key result' },
        { method: 'PATCH', path: '/key-results/:id', description: 'Update key result metadata' },
        { method: 'DELETE', path: '/key-results/:id', description: 'Delete a key result' },
        { method: 'POST', path: '/key-results/:id/value', description: 'Record a value check-in for a key result' },
        { method: 'GET', path: '/key-results/:id/links', description: 'List entity links for a key result' },
        { method: 'POST', path: '/key-results/:id/links', description: 'Link a key result to a Bam entity for auto-progress' },
        { method: 'DELETE', path: '/key-results/:id/links/:linkId', description: 'Remove a link from a key result' },
        { method: 'GET', path: '/key-results/:id/history', description: 'Get value snapshot history for a key result' },
      ],
    },
    {
      name: 'Reports',
      endpoints: [
        { method: 'GET', path: '/reports/period/:periodId', description: 'Generate a period summary report' },
        { method: 'GET', path: '/reports/at-risk', description: 'List all at-risk and behind goals' },
        { method: 'GET', path: '/reports/owner/:userId', description: "Generate a report of a user's goals" },
        { method: 'POST', path: '/reports/generate', description: 'Generate a formatted report by type' },
      ],
    },
  ],
};

const boardApi: ApiService = {
  name: 'Board API',
  baseUrl: '/board/api/v1',
  description: 'Visual collaboration whiteboard -- rooms, shapes, real-time canvas sync, audio conferencing, and cross-product embeds.',
  color: 'bg-cyan-100 text-cyan-700',
  groups: [
    {
      name: 'Rooms',
      endpoints: [
        { method: 'GET', path: '/rooms', description: 'List whiteboard rooms with optional project and status filters' },
        { method: 'POST', path: '/rooms', description: 'Create a new whiteboard room' },
        { method: 'GET', path: '/rooms/:id', description: 'Get room details including participant list' },
        { method: 'PATCH', path: '/rooms/:id', description: 'Update room name, description, or settings' },
        { method: 'DELETE', path: '/rooms/:id', description: 'Delete a whiteboard room' },
        { method: 'POST', path: '/rooms/:id/duplicate', description: 'Duplicate a whiteboard room with all shapes' },
      ],
    },
    {
      name: 'Shapes',
      endpoints: [
        { method: 'GET', path: '/rooms/:id/shapes', description: 'List all shapes on the canvas' },
        { method: 'POST', path: '/rooms/:id/shapes', description: 'Add a shape to the canvas' },
        { method: 'PATCH', path: '/shapes/:id', description: 'Update shape properties' },
        { method: 'DELETE', path: '/shapes/:id', description: 'Remove a shape from the canvas' },
        { method: 'POST', path: '/rooms/:id/shapes/bulk', description: 'Bulk add, update, or delete shapes' },
      ],
    },
    {
      name: 'Canvas',
      endpoints: [
        { method: 'GET', path: '/rooms/:id/canvas', description: 'Get full canvas state as structured JSON' },
        { method: 'GET', path: '/rooms/:id/snapshot', description: 'Generate a PNG snapshot of the canvas' },
      ],
    },
    {
      name: 'Assets',
      endpoints: [
        { method: 'POST', path: '/rooms/:id/assets', description: 'Upload an image or file to the canvas' },
        { method: 'GET', path: '/rooms/:id/assets', description: 'List uploaded assets for a room' },
        { method: 'DELETE', path: '/assets/:id', description: 'Delete an uploaded asset' },
      ],
    },
    {
      name: 'Participants',
      endpoints: [
        { method: 'GET', path: '/rooms/:id/participants', description: 'List active participants and their cursors' },
        { method: 'POST', path: '/rooms/:id/join', description: 'Join a whiteboard room' },
        { method: 'POST', path: '/rooms/:id/leave', description: 'Leave a whiteboard room' },
      ],
    },
    {
      name: 'Chat',
      endpoints: [
        { method: 'GET', path: '/rooms/:id/chat', description: 'List side-chat messages for a room' },
        { method: 'POST', path: '/rooms/:id/chat', description: 'Post a message in the room side-chat' },
      ],
    },
    {
      name: 'Templates & Pipeline',
      endpoints: [
        { method: 'GET', path: '/templates', description: 'List whiteboard templates' },
        { method: 'POST', path: '/templates/:id/create', description: 'Create a room from a template' },
        { method: 'POST', path: '/shapes/:id/to-task', description: 'Convert a sticky note into a Bam task' },
        { method: 'POST', path: '/rooms/:id/embeds', description: 'Embed a cross-product item on the canvas' },
      ],
    },
    {
      name: 'Audio',
      endpoints: [
        { method: 'POST', path: '/rooms/:id/audio/start', description: 'Start audio conferencing in a room' },
        { method: 'POST', path: '/rooms/:id/audio/join', description: 'Join the audio session' },
        { method: 'POST', path: '/rooms/:id/audio/leave', description: 'Leave the audio session' },
        { method: 'POST', path: '/rooms/:id/audio/end', description: 'End the audio session for all participants' },
      ],
    },
  ],
};

const bondApi: ApiService = {
  name: 'Bond API',
  baseUrl: '/bond/api/v1',
  description: 'CRM pipeline management -- contacts, companies, deals, activities, pipeline stages, and reporting.',
  color: 'bg-pink-100 text-pink-700',
  groups: [
    {
      name: 'Contacts',
      endpoints: [
        { method: 'GET', path: '/contacts', description: 'List contacts with filters (company, tag, search, status)' },
        { method: 'POST', path: '/contacts', description: 'Create a new contact' },
        { method: 'GET', path: '/contacts/:id', description: 'Get a contact with linked companies, deals, and activities' },
        { method: 'PATCH', path: '/contacts/:id', description: 'Update contact fields' },
        { method: 'DELETE', path: '/contacts/:id', description: 'Archive a contact (soft-delete)' },
        { method: 'POST', path: '/contacts/:id/restore', description: 'Restore an archived contact' },
        { method: 'POST', path: '/contacts/merge', description: 'Merge duplicate contacts into a primary record' },
      ],
    },
    {
      name: 'Companies',
      endpoints: [
        { method: 'GET', path: '/companies', description: 'List companies with filters and pagination' },
        { method: 'POST', path: '/companies', description: 'Create a new company' },
        { method: 'GET', path: '/companies/:id', description: 'Get a company with linked contacts and deals' },
        { method: 'PATCH', path: '/companies/:id', description: 'Update company fields' },
        { method: 'DELETE', path: '/companies/:id', description: 'Archive a company' },
        { method: 'GET', path: '/companies/:id/contacts', description: 'List contacts at a company' },
      ],
    },
    {
      name: 'Deals',
      endpoints: [
        { method: 'GET', path: '/deals', description: 'List deals with pipeline, stage, owner, and value filters' },
        { method: 'POST', path: '/deals', description: 'Create a new deal' },
        { method: 'GET', path: '/deals/:id', description: 'Get a deal with contacts, activities, and stage history' },
        { method: 'PATCH', path: '/deals/:id', description: 'Update deal fields (value, probability, owner, etc.)' },
        { method: 'DELETE', path: '/deals/:id', description: 'Archive a deal' },
        { method: 'POST', path: '/deals/:id/move', description: 'Move a deal to a different pipeline stage' },
        { method: 'POST', path: '/deals/:id/contacts', description: 'Link a contact to a deal' },
        { method: 'DELETE', path: '/deals/:id/contacts/:contactId', description: 'Unlink a contact from a deal' },
      ],
    },
    {
      name: 'Activities',
      endpoints: [
        { method: 'GET', path: '/activities', description: 'List activities with entity, type, and date filters' },
        { method: 'POST', path: '/activities', description: 'Log an activity (call, email, meeting, note, task)' },
        { method: 'GET', path: '/activities/:id', description: 'Get activity details' },
        { method: 'PATCH', path: '/activities/:id', description: 'Update an activity' },
        { method: 'DELETE', path: '/activities/:id', description: 'Delete an activity' },
      ],
    },
    {
      name: 'Pipeline',
      endpoints: [
        { method: 'GET', path: '/pipelines', description: 'List pipeline configurations' },
        { method: 'POST', path: '/pipelines', description: 'Create a pipeline with stages' },
        { method: 'GET', path: '/pipelines/:id', description: 'Get a pipeline with stage definitions' },
        { method: 'PATCH', path: '/pipelines/:id', description: 'Update pipeline name or stage ordering' },
        { method: 'POST', path: '/pipelines/:id/stages', description: 'Add a stage to the pipeline' },
        { method: 'PATCH', path: '/stages/:id', description: 'Update a pipeline stage' },
        { method: 'DELETE', path: '/stages/:id', description: 'Remove a pipeline stage' },
      ],
    },
    {
      name: 'Reports',
      endpoints: [
        { method: 'GET', path: '/reports/pipeline', description: 'Pipeline report (conversion, avg deal size, stage duration)' },
        { method: 'GET', path: '/reports/forecast', description: 'Revenue forecast based on weighted pipeline' },
        { method: 'GET', path: '/reports/activity', description: 'Activity report by type, user, and date range' },
        { method: 'GET', path: '/reports/win-loss', description: 'Win/loss analysis with reasons and trends' },
      ],
    },
    {
      name: 'Search & Tags',
      endpoints: [
        { method: 'GET', path: '/search', description: 'Cross-entity search across contacts, companies, deals, and activities' },
        { method: 'GET', path: '/tags', description: 'List all tags with usage counts' },
        { method: 'POST', path: '/contacts/:id/tags', description: 'Add tags to a contact' },
        { method: 'DELETE', path: '/contacts/:id/tags/:tag', description: 'Remove a tag from a contact' },
      ],
    },
  ],
};

const allApis: ApiService[] = [bamApi, banterApi, beaconApi, briefApi, boltApi, bearingApi, boardApi, bondApi, helpdeskApi];

/* ------------------------------------------------------------------ */
/*  FAQ Data                                                           */
/* ------------------------------------------------------------------ */

interface Faq {
  question: string;
  answer: string;
}

const faqs: Faq[] = [
  {
    question: 'What is BigBlueBam?',
    answer: 'BigBlueBam is a comprehensive work management platform that combines project planning (Bam), team messaging (Banter), a knowledge base (Beacon), collaborative documents (Brief), workflow automation (Bolt), goals and OKR tracking (Bearing), visual collaboration whiteboards (Board), CRM pipeline management (Bond), and a customer support portal (Helpdesk) into a single self-hosted stack. It is designed for small-to-medium teams of 2 to 50 users who want an integrated alternative to juggling Jira, Slack, Confluence, Salesforce, and Zendesk separately.',
  },
  {
    question: 'How many apps are included?',
    answer: `BigBlueBam ships with ${APP_COUNT_WORDS} integrated applications: Bam (Kanban project management with sprints), Banter (real-time messaging with channels, DMs, threads, voice/video calls, and scheduled posts), Beacon (knowledge base with semantic search and a knowledge graph), Brief (collaborative WYSIWYG documents), Bolt (WHEN/IF/THEN workflow automations with runtime observability), Bearing (goals and OKR tracking), Board (infinite-canvas visual collaboration whiteboards with real-time editing and audio conferencing), Bond (CRM with visual deal pipeline, contact and company management, activity tracking, and dedupe primitives), Blast (email campaigns with templates, segments, and analytics), Bill (invoicing, expenses, PDF generation, and recurring billing), Blank (forms with conditional logic routing), Blueprint (structured-diagram editor with typed graph nodes and auto-layout), Book (scheduling and public booking pages), Bench (analytics dashboards and scheduled reports), Bureau (virtual office with rooms, presence, and knock-to-enter), Bin (digital asset manager and structured-data editor backed by object storage), Bay (media review and approval with annotations and public guest links), Blip (telemetry and event tracking), Helpdesk (customer support ticket portal with similar-ticket lookup), Basis (a governed metric layer where you define a business metric once, read it everywhere, and an AI core explains why a certified metric moved), Braid (customer identity resolution that merges source records into golden profiles with survivorship rules and a review queue), Bulwark (an AI contract-obligation monitor that reads executed contracts, extracts a clause-cited ledger of every obligation, and fires deadline alerts with AI-drafted, human-approved notices), Burn (an AI scope-and-margin monitor that reads the signed SOW into a priced deliverable ledger, attributes every logged hour to it, and gates out-of-scope spend before it posts), Bursar (AI procurement leveling that normalizes competing vendor bids against one cited scope, freezes the award as a baseline, and watches spend for drift), and Bastion (continuous compliance readiness for SOC 2 and ISO 27001 that checks one shared control library against what really happened in the suite every night, keeps a sealed evidence ledger, and drafts questionnaire answers it can prove). All ${APP_COUNT_WORDS} apps share a single authentication system, cross-link to each other seamlessly, and surface into a single cross-app search, composite subject views, and a durable entity-links table.`,
  },
  {
    question: 'What is the difference between Beacon and Brief?',
    answer: 'Beacon is the team knowledge base: it stores verified, canonical information articles that go through a publish-verify-challenge lifecycle with governance policies and freshness tracking. Brief is the collaborative document editor for drafting, note-taking, meeting minutes, and specs -- documents that may still be evolving. When a Brief document stabilizes and becomes authoritative, you can promote it to a Beacon article with one click.',
  },
  {
    question: 'How do AI agents work with BigBlueBam?',
    answer: `BigBlueBam exposes ${MCP_TOOL_COUNT} MCP (Model Context Protocol) tools on a dedicated server endpoint at /mcp/. Any MCP-compatible AI agent -- Claude, GPT, or custom agents -- can connect and manage tasks, post messages, search the knowledge base, write documents, create automations, track goals, collaborate on visual whiteboards, manage the CRM pipeline, invoice clients, run email campaigns, build dashboards, and schedule meetings. Destructive actions require a two-step confirmation flow with Redis-backed tokens to prevent accidental data loss. Service-account agents run behind a fail-closed policy gate (kill switches plus per-agent tool allowlists) and a first-class approval queue routes human-gated actions through a durable inbox. The MCP server supports Streamable HTTP, SSE, and stdio transports.`,
  },
  {
    question: 'What is MCP?',
    answer: `MCP stands for Model Context Protocol, an open standard for connecting AI models to external tools and data sources. Instead of building custom integrations for each AI provider, BigBlueBam implements MCP once and any compliant agent can use all ${MCP_TOOL_COUNT} tools. You can learn more at modelcontextprotocol.io.`,
  },
  {
    question: 'Can I use my own LLM?',
    answer: 'Yes. BigBlueBam supports configurable LLM providers in Settings. You can connect OpenAI, Anthropic, Azure OpenAI, or any OpenAI-compatible API (such as a local Ollama instance). The platform resolves which provider to use based on capability (embedding, chat, triage) and you can test connectivity from the settings page before enabling it for production use.',
  },
  {
    question: 'Is BigBlueBam open source?',
    answer: `BigBlueBam is source-available on GitHub. The full codebase -- frontends, ${APP_COUNT_WORDS} app APIs, Docker Compose stack, Helm chart, and migrations -- is in a single monorepo. You can self-host it on your own infrastructure with no external dependencies beyond the Docker images. Check the repository for the specific license terms.`,
  },
  {
    question: 'How do I deploy BigBlueBam?',
    answer: `The quickest way is to clone the repository, copy .env.example to .env, fill in your secrets, and run docker compose up -d. This starts a full stack including PostgreSQL, Redis, MinIO, Qdrant, all ${APP_COUNT_WORDS} app APIs, their frontends, the MCP server, and a background worker. Everything is accessible through a single nginx reverse proxy on port 80. For production, a Helm chart is provided at infra/helm/ for Kubernetes deployment. Operators can also skip the CLI admin prompt entirely and have the first visitor create the SuperUser account from the site via the new /b3/bootstrap page.`,
  },
  {
    question: 'What database does it use?',
    answer: 'BigBlueBam uses PostgreSQL 16 as the primary database, with Row-Level Security, JSONB for custom fields, and monthly-partitioned activity logs. Redis 7 handles sessions, caching, pub/sub for real-time WebSocket broadcasts, and BullMQ job queues. MinIO (S3-compatible) stores file attachments, and Qdrant provides vector storage for Beacon semantic search. All data services can be swapped for managed cloud equivalents by changing environment variables.',
  },
  {
    question: 'Can multiple users edit a Brief document at the same time?',
    answer: 'Brief supports collaborative editing with real-time cursor presence. Multiple users can open the same document simultaneously and see each other\'s cursors and edits. The editor is built on Tiptap (a ProseMirror-based WYSIWYG editor) with WebSocket synchronization. Conflict resolution follows an operational-transform-like approach to merge concurrent edits smoothly.',
  },
  {
    question: 'What happens when a sprint ends with incomplete tasks?',
    answer: 'When you complete a sprint, BigBlueBam presents a carry-forward dialog showing all incomplete tasks. You choose which tasks to carry forward into the next sprint and which to send back to the backlog. Carried-forward tasks retain their history and display a badge with the carry-forward count so the team can track how many sprints a task has rolled over. This is a first-class concept in the data model, not an afterthought.',
  },
  {
    question: 'How does the Helpdesk connect to the project board?',
    answer: 'When a customer submits a support ticket through the Helpdesk portal, agents can convert that ticket into a Bam task with one click, linking it to the relevant project. The task retains a reference to the original ticket, so updates flow both ways. AI triage can automatically suggest priority, category, and assignee based on the ticket content and your knowledge base.',
  },
  {
    question: 'What are Bolt automations?',
    answer: 'Bolt is BigBlueBam\'s workflow automation engine. Each automation follows a WHEN/IF/THEN pattern: WHEN an event happens (like a task moving to "Done"), IF conditions are met (like the task having a specific label), THEN execute one or more actions (like posting a message in Banter or updating a field). Actions are MCP tools, so automations can do anything an AI agent can do -- create tasks, send messages, update beacons, and more.',
  },
  {
    question: 'How do I create a Bolt automation?',
    answer: 'Navigate to the Bolt app, click "New Automation," and configure your trigger event, optional conditions, and actions using the visual builder. You can also describe what you want in plain English and use the AI Assist feature to generate a suggested automation definition. Before enabling, use the Test button to simulate the automation with a sample event payload and verify the output.',
  },
  {
    question: 'Can I use BigBlueBam without Docker?',
    answer: 'While Docker Compose is the recommended and tested deployment method, you can run each service natively if you have Node.js 22, PostgreSQL 16, Redis 7, MinIO, and Qdrant installed locally. You would need to start each service manually, configure environment variables for each, and set up nginx or another reverse proxy. For development, the docker-compose.dev.yml adds hot-reload volume mounts while still using containerized data services.',
  },
  {
    question: 'What browsers are supported?',
    answer: 'BigBlueBam supports the latest two major versions of Chrome, Firefox, Safari, and Edge. The frontend is a React 19 SPA that uses modern CSS features (TailwindCSS v4) and JavaScript APIs. Internet Explorer is not supported. Mobile browsers work for basic tasks, but the Kanban board drag-and-drop experience is optimized for desktop screens.',
  },
  {
    question: 'How do I reset my password?',
    answer: 'If you are logged in, go to your profile settings and use the Change Password form. If you are locked out, an organization admin or platform SuperUser can reset your password from the People management page. If SMTP is configured, the platform also supports email-based password reset flows through the login page.',
  },
  {
    question: 'How do I backup my data?',
    answer: 'Since BigBlueBam uses standard PostgreSQL, you can use pg_dump for database backups. MinIO supports bucket replication and can be backed up with standard S3 tools like rclone. Redis data is ephemeral (sessions and cache) and does not need backup. For a full backup strategy, schedule pg_dump via cron and replicate your MinIO bucket to a secondary location or cloud storage.',
  },
  {
    question: 'What is the maximum number of users?',
    answer: 'There is no hard limit built into BigBlueBam. The platform is designed for teams of 2 to 50 users and has been load-tested at that scale. For larger teams, the stateless application containers (API, frontend, worker) scale horizontally behind a load balancer. PostgreSQL with connection pooling (PgBouncer) and Redis clustering can handle hundreds of concurrent users with proper infrastructure.',
  },
  {
    question: 'How do I contribute?',
    answer: 'Contributions are welcome via GitHub pull requests. The repository uses a Turborepo monorepo with pnpm workspaces. Run pnpm install to set up the workspace, start the Docker stack for integration testing, and submit a PR. The CI pipeline runs lint (Biome), typecheck (tsc --noEmit), and unit tests (Vitest) on every push. See the CLAUDE.md file in the repo root for detailed development guidelines.',
  },
];

/* ------------------------------------------------------------------ */
/*  Shared Components                                                  */
/* ------------------------------------------------------------------ */

function ToolTable({ tools }: { tools: Tool[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className="pb-2 pr-4 text-left font-semibold text-zinc-700" style={{ width: '260px' }}>Tool</th>
            <th className="pb-2 text-left font-semibold text-zinc-700">Description</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.name} className="border-b border-zinc-100 last:border-0">
              <td className="py-2 pr-4 align-top">
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-800">{tool.name}</code>
              </td>
              <td className="py-2 text-zinc-600">{tool.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategorySection({ category, defaultOpen = false }: { category: ToolCategory; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-left text-sm font-medium text-zinc-800 transition-colors hover:text-zinc-950"
      >
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        {category.name}
        <span className="ml-1 text-xs font-normal text-zinc-400">({category.tools.length})</span>
      </button>
      {open && (
        <div className="pb-4 pl-6">
          <ToolTable tools={category.tools} />
        </div>
      )}
    </div>
  );
}

function ProductSection({ product }: { product: ToolProduct }) {
  const [expanded, setExpanded] = useState(false);
  const totalTools = getTotalTools(product);

  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${product.color}`}>
          {product.icon}
        </div>
        <h3 className="text-xl font-bold text-zinc-900">
          {product.name}
          <span className="ml-2 text-sm font-normal text-zinc-500">({totalTools} tools)</span>
        </h3>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-xs font-medium text-primary-600 transition-colors hover:text-primary-700"
        >
          {expanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white px-4">
        {product.categories.map((cat) => (
          <CategorySection key={cat.name} category={cat} defaultOpen={expanded} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  API Endpoint Components                                            */
/* ------------------------------------------------------------------ */

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'bg-emerald-100 text-emerald-700',
    POST: 'bg-primary-100 text-primary-700',
    PATCH: 'bg-amber-100 text-amber-700',
    PUT: 'bg-orange-100 text-orange-700',
    DELETE: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`inline-block w-16 rounded px-1.5 py-0.5 text-center text-xs font-bold ${colors[method] || 'bg-zinc-100 text-zinc-700'}`}>
      {method}
    </span>
  );
}

function EndpointTable({ endpoints }: { endpoints: Endpoint[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className="pb-2 pr-3 text-left font-semibold text-zinc-700" style={{ width: '70px' }}>Method</th>
            <th className="pb-2 pr-4 text-left font-semibold text-zinc-700" style={{ width: '320px' }}>Path</th>
            <th className="pb-2 text-left font-semibold text-zinc-700">Description</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep, i) => (
            <tr key={`${ep.method}-${ep.path}-${i}`} className="border-b border-zinc-100 last:border-0">
              <td className="py-2 pr-3 align-top">
                <MethodBadge method={ep.method} />
              </td>
              <td className="py-2 pr-4 align-top">
                <code className="text-xs font-medium text-zinc-800">{ep.path}</code>
              </td>
              <td className="py-2 text-zinc-600">{ep.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointGroupSection({ group, defaultOpen = false }: { group: EndpointGroup; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-left text-sm font-medium text-zinc-800 transition-colors hover:text-zinc-950"
      >
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        {group.name}
        <span className="ml-1 text-xs font-normal text-zinc-400">({group.endpoints.length})</span>
      </button>
      {open && (
        <div className="pb-4 pl-6">
          <EndpointTable endpoints={group.endpoints} />
        </div>
      )}
    </div>
  );
}

function ApiServiceSection({ service }: { service: ApiService }) {
  const [expanded, setExpanded] = useState(false);
  const totalEndpoints = service.groups.reduce((sum, g) => sum + g.endpoints.length, 0);

  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${service.color}`}>
          <Server className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-xl font-bold text-zinc-900">
            {service.name}
            <span className="ml-2 text-sm font-normal text-zinc-500">({totalEndpoints} endpoints)</span>
          </h3>
          <p className="text-xs text-zinc-500">
            Base URL: <code className="rounded bg-zinc-100 px-1 py-0.5">{service.baseUrl}</code>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-xs font-medium text-primary-600 transition-colors hover:text-primary-700"
        >
          {expanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <p className="mb-4 text-sm text-zinc-600">{service.description}</p>
      <div className="rounded-lg border border-zinc-200 bg-white px-4">
        {service.groups.map((group) => (
          <EndpointGroupSection key={group.name} group={group} defaultOpen={expanded} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section Content Components                                         */
/* ------------------------------------------------------------------ */

function McpToolsContent() {
  return (
    <>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">MCP Tools Reference</h1>
        <p className="mt-3 max-w-2xl text-base text-zinc-600">
          BigBlueBam exposes <strong>{MCP_TOOL_COUNT} MCP tools</strong> across {allProducts.length} products, enabling AI agents
          to manage tasks, communicate in channels, search knowledge bases, author documents, orchestrate
          automations, track goals, collaborate on visual whiteboards, and manage CRM pipelines -- all through the{' '}
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-600 underline underline-offset-2 hover:text-primary-700"
          >
            Model Context Protocol
          </a>
          .
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          Destructive actions require a two-step confirmation flow via <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">confirm_action</code>.
          All tools are available on the <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">/mcp/</code> endpoint via Streamable HTTP, SSE, or stdio transports.
        </p>
      </div>

      {allProducts.map((product) => (
        <div key={product.name} id={product.name.toLowerCase()}>
          <ProductSection product={product} />
        </div>
      ))}

      <div className="mt-12 rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
        <p className="font-medium text-zinc-800">Need help?</p>
        <p className="mt-1">
          Use <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">get_server_info</code> to inspect available tools and your current rate limit status at runtime.
          For questions or feedback, visit the{' '}
          <a href="/#cta" className="font-medium text-primary-600 underline underline-offset-2 hover:text-primary-700">
            contact section
          </a>
          .
        </p>
      </div>
    </>
  );
}

function ApiEndpointsContent() {
  const totalEndpoints = allApis.reduce(
    (sum, api) => sum + api.groups.reduce((s, g) => s + g.endpoints.length, 0),
    0,
  );

  return (
    <>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">API Endpoints</h1>
        <p className="mt-3 max-w-2xl text-base text-zinc-600">
          BigBlueBam exposes <strong>{totalEndpoints} REST endpoints</strong> across eight API services, all accessible
          through a single nginx reverse proxy on port 80. Every endpoint uses JSON request/response bodies, session
          cookie or API key authentication, and cursor-based pagination on list endpoints.
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          Filter with <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">?filter[field]=value</code>.
          Sort with <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">?sort=-field</code> (prefix with <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">-</code> for descending).
          All errors follow a standard envelope: <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">{'{ "error": { "code", "message", "details", "request_id" } }'}</code>.
        </p>
      </div>

      {allApis.map((api) => (
        <div key={api.name} id={`api-${api.name.toLowerCase().replace(/\s+/g, '-')}`}>
          <ApiServiceSection service={api} />
        </div>
      ))}

      <div className="mt-12 rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
        <p className="font-medium text-zinc-800">Authentication</p>
        <p className="mt-1">
          All endpoints (except those marked "no auth") require either a session cookie from <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">POST /auth/login</code> or
          an API key in the <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">Authorization: Bearer bbam_...</code> header.
          API keys are scoped to read, read_write, or admin permissions with optional project restrictions.
        </p>
      </div>
    </>
  );
}

function DeploymentContent() {
  return (
    <>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Deployment Guide</h1>
        <p className="mt-3 max-w-2xl text-base text-zinc-600">
          Everything you need to deploy, configure, and maintain a BigBlueBam instance. The platform runs
          as a multi-service Docker Compose stack ({APP_COUNT_WORDS} app APIs plus MCP server, worker, voice agent, frontends, and data services) behind a single nginx reverse proxy.
        </p>
      </div>

      <div className="space-y-8">
        {/* Deploy guide link */}
        <div className="rounded-lg border-2 border-primary-200 bg-primary-50 p-6">
          <p className="text-sm text-zinc-700 leading-relaxed">
            For a step-by-step walkthrough, see the{' '}
            <a href="/deploy" className="font-bold text-primary-700 underline underline-offset-2 hover:text-primary-800">
              Deployment Guide
            </a>
            . It covers everything from running the deploy script to creating your first admin account.
          </p>
        </div>

        {/* Prerequisites */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Prerequisites</h2>
          <ul className="space-y-2 text-sm text-zinc-600">
            <li className="flex items-start gap-2">
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
              <span><strong>Docker</strong> 24+ and <strong>Docker Compose</strong> v2 (included with Docker Desktop)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
              <span><strong>4 GB RAM minimum</strong> for the full stack (8 GB recommended for development)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
              <span><strong>Node.js 22 LTS</strong> and <strong>pnpm</strong> (only needed for local development, not for Docker deployment)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
              <span><strong>10 GB disk space</strong> for Docker images and initial data</span>
            </li>
          </ul>
        </div>

        {/* Quick Start */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Quick Start</h2>
          <p className="mb-4 text-sm text-zinc-600">
            Get BigBlueBam running in under 5 minutes with Docker Compose.
          </p>
          <div className="space-y-3">
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">1. Clone and configure</p>
              <code className="text-xs text-zinc-700">
                git clone https://github.com/your-org/BigBlueBam.git<br />
                cd BigBlueBam<br />
                cp .env.example .env<br />
                # Edit .env with your secrets
              </code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">2. Start the stack</p>
              <code className="text-xs text-zinc-700">docker compose up -d</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">3. Create the first admin user</p>
              <code className="text-xs text-zinc-700">
                docker compose exec api node dist/cli.js create-admin \<br />
                {'  '}--email admin@example.com --password your-password \<br />
                {'  '}--name "Admin" --org "My Organization"
              </code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">4. Open in browser</p>
              <code className="text-xs text-zinc-700">http://localhost</code>
            </div>
          </div>
        </div>

        {/* Environment Variables */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Environment Variables</h2>
          <p className="mb-4 text-sm text-zinc-600">
            Key configuration variables in <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">.env</code>. See <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">.env.example</code> for the complete list.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200">
                  <th className="pb-2 pr-4 text-left font-semibold text-zinc-700">Variable</th>
                  <th className="pb-2 pr-4 text-left font-semibold text-zinc-700">Required</th>
                  <th className="pb-2 text-left font-semibold text-zinc-700">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600">
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">POSTGRES_USER</code></td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">PostgreSQL superuser name</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">POSTGRES_PASSWORD</code></td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">PostgreSQL superuser password</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">REDIS_PASSWORD</code></td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">Redis authentication password</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">SESSION_SECRET</code></td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">Secret for signing session cookies (use a long random string)</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">MINIO_ROOT_USER</code></td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">MinIO admin username for file storage</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">MINIO_ROOT_PASSWORD</code></td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">MinIO admin password</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">SMTP_HOST</code></td>
                  <td className="py-2 pr-4">No</td>
                  <td className="py-2">SMTP server for sending emails (password resets, notifications)</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">SMTP_PORT</code></td>
                  <td className="py-2 pr-4">No</td>
                  <td className="py-2">SMTP port (default: 587)</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">OPENAI_API_KEY</code></td>
                  <td className="py-2 pr-4">No</td>
                  <td className="py-2">OpenAI API key for AI features (can be configured in Settings instead)</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">ANTHROPIC_API_KEY</code></td>
                  <td className="py-2 pr-4">No</td>
                  <td className="py-2">Anthropic API key for Claude-based AI features</td>
                </tr>
                <tr className="border-b border-zinc-100">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">GITHUB_CLIENT_ID</code></td>
                  <td className="py-2 pr-4">No</td>
                  <td className="py-2">GitHub OAuth app client ID for GitHub integration</td>
                </tr>
                <tr className="border-b border-zinc-100 last:border-0">
                  <td className="py-2 pr-4"><code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">DOMAIN</code></td>
                  <td className="py-2 pr-4">No</td>
                  <td className="py-2">Public domain name (defaults to localhost)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Services Architecture */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Services Architecture</h2>
          <p className="mb-4 text-sm text-zinc-600">
            The Docker Compose stack runs 19 services. Application containers are stateless and scale horizontally.
            Data services can be swapped for managed cloud equivalents by changing environment variables.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200">
                  <th className="pb-2 pr-4 text-left font-semibold text-zinc-700">Service</th>
                  <th className="pb-2 pr-4 text-left font-semibold text-zinc-700">Internal Port</th>
                  <th className="pb-2 text-left font-semibold text-zinc-700">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600">
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">frontend</td><td className="py-2 pr-4">80</td><td className="py-2">nginx reverse proxy + SPA static files</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">api</td><td className="py-2 pr-4">4000</td><td className="py-2">Bam Fastify REST API + WebSocket server</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">banter-api</td><td className="py-2 pr-4">4002</td><td className="py-2">Banter messaging API + WebSocket server</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">beacon-api</td><td className="py-2 pr-4">4004</td><td className="py-2">Beacon knowledge base API</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">brief-api</td><td className="py-2 pr-4">4005</td><td className="py-2">Brief collaborative documents API</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">bolt-api</td><td className="py-2 pr-4">4006</td><td className="py-2">Bolt automation engine API</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">bearing-api</td><td className="py-2 pr-4">4007</td><td className="py-2">Bearing goals and OKR tracking API</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">board-api</td><td className="py-2 pr-4">4008</td><td className="py-2">Board visual collaboration whiteboard API + WebSocket</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">bond-api</td><td className="py-2 pr-4">4009</td><td className="py-2">Bond CRM pipeline and contact management API</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">helpdesk-api</td><td className="py-2 pr-4">4001</td><td className="py-2">Helpdesk support ticket API</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">mcp-server</td><td className="py-2 pr-4">3001</td><td className="py-2">MCP protocol server ({MCP_TOOL_COUNT} tools)</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">worker</td><td className="py-2 pr-4">--</td><td className="py-2">BullMQ background jobs (email, notifications, export, sprint-close)</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">migrate</td><td className="py-2 pr-4">--</td><td className="py-2">Runs SQL migrations on startup, then exits</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">postgres</td><td className="py-2 pr-4">5432</td><td className="py-2">PostgreSQL 16 primary database</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">redis</td><td className="py-2 pr-4">6379</td><td className="py-2">Redis 7 (sessions, cache, pub/sub, queues)</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">minio</td><td className="py-2 pr-4">9000</td><td className="py-2">MinIO S3-compatible file storage</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">qdrant</td><td className="py-2 pr-4">6333</td><td className="py-2">Qdrant vector database (semantic search)</td></tr>
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">voice-agent</td><td className="py-2 pr-4">4003</td><td className="py-2">AI voice agent (Python/FastAPI, LiveKit)</td></tr>
                <tr className="border-b border-zinc-100 last:border-0"><td className="py-2 pr-4 font-medium">livekit</td><td className="py-2 pr-4">7880</td><td className="py-2">LiveKit SFU for voice/video calls</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Development Mode */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Development Mode</h2>
          <p className="mb-3 text-sm text-zinc-600">
            For local development with hot reload, use the dev compose override:
          </p>
          <div className="mb-3 rounded-md bg-zinc-50 p-3">
            <code className="text-xs text-zinc-700">docker compose -f docker-compose.yml -f docker-compose.dev.yml up</code>
          </div>
          <p className="text-sm text-zinc-600">
            This mounts your local source directories into the containers and starts services with file watchers. Changes
            to TypeScript files trigger automatic rebuilds and restarts. Data services (PostgreSQL, Redis, MinIO, Qdrant)
            still run in containers so you don't need to install them locally.
          </p>
        </div>

        {/* Running Tests */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Running Tests</h2>
          <p className="mb-3 text-sm text-zinc-600">
            BigBlueBam has 900+ tests across all packages, using Vitest as the test runner.
          </p>
          <div className="space-y-2">
            <div className="rounded-md bg-zinc-50 p-3">
              <code className="text-xs text-zinc-700">pnpm test                                    # Run all tests</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <code className="text-xs text-zinc-700">pnpm --filter @bigbluebam/api test           # API tests only</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <code className="text-xs text-zinc-700">pnpm --filter @bigbluebam/frontend test      # Frontend tests only</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <code className="text-xs text-zinc-700">pnpm --filter @bigbluebam/shared test        # Shared schemas only</code>
            </div>
          </div>
          <p className="mt-3 text-sm text-zinc-600">
            CI runs lint (Biome), typecheck (tsc --noEmit), and unit tests on every push. PRs additionally spin up an
            ephemeral Docker Compose stack for integration tests.
          </p>
        </div>

        {/* Updating / Rebuilding */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Updating and Rebuilding</h2>
          <p className="mb-3 text-sm text-zinc-600">
            When updating BigBlueBam, rebuild only the services that changed. <strong>Never run{' '}
            <code className="rounded bg-red-100 px-1 py-0.5 text-xs text-red-700">docker compose down -v</code></strong> unless
            you intentionally want to wipe all data -- the <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">-v</code> flag
            destroys PostgreSQL data, Redis data, and MinIO uploads.
          </p>
          <div className="space-y-2">
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">Rebuild and restart a single service</p>
              <code className="text-xs text-zinc-700">docker compose build api && docker compose up -d --force-recreate api</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">Restart nginx after frontend rebuild</p>
              <code className="text-xs text-zinc-700">docker compose build frontend && docker compose restart frontend</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">Stop without wiping data</p>
              <code className="text-xs text-zinc-700">docker compose down</code>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="mb-1 text-xs font-medium text-zinc-500">Pull latest and rebuild everything</p>
              <code className="text-xs text-zinc-700">git pull && docker compose build && docker compose up -d</code>
            </div>
          </div>
        </div>

        {/* Database Migrations */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Database Migrations</h2>
          <p className="mb-3 text-sm text-zinc-600">
            Schema migrations live in <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">infra/postgres/migrations/</code> as
            numbered, idempotent SQL files (e.g., <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">0001_add_custom_fields.sql</code>).
            The <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">migrate</code> service runs automatically on every{' '}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">docker compose up</code>, applies any new migrations,
            and tracks progress in a <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">schema_migrations</code> table with
            SHA-256 checksums.
          </p>
          <p className="mb-3 text-sm text-zinc-600">
            <strong>Never edit an existing migration.</strong> The runner compares checksums and will abort on mismatch.
            Always add a new numbered file for schema changes. Every migration must be idempotent using patterns like{' '}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">CREATE TABLE IF NOT EXISTS</code> and{' '}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">ADD COLUMN IF NOT EXISTS</code>.
          </p>
          <p className="text-sm text-zinc-600">
            After adding a new migration, rebuild the API image (<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">docker compose build api</code>)
            so the migration file is baked in, then restart the stack.
          </p>
        </div>

        {/* LLM Provider Setup */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">LLM Provider Setup</h2>
          <p className="mb-3 text-sm text-zinc-600">
            BigBlueBam's AI features (Helpdesk triage, Beacon semantic search, Bolt AI assist) require an LLM provider.
            Configure providers in two ways:
          </p>
          <ul className="space-y-2 text-sm text-zinc-600">
            <li className="flex items-start gap-2">
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
              <span><strong>Environment variables:</strong> Set <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">OPENAI_API_KEY</code> or <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">ANTHROPIC_API_KEY</code> in your .env file for a quick default.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
              <span><strong>Settings UI:</strong> Navigate to Settings in Bam and use the LLM Providers page to add, configure, and test providers. You can set up multiple providers and configure which one handles each capability (chat, embedding, triage).</span>
            </li>
          </ul>
          <p className="mt-3 text-sm text-zinc-600">
            BigBlueBam supports OpenAI, Anthropic, Azure OpenAI, and any OpenAI-compatible API endpoint (including local
            Ollama instances). Use the Test button on each provider to verify connectivity before enabling it.
          </p>
        </div>

        {/* Kubernetes / Helm */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Kubernetes / Helm</h2>
          <p className="text-sm text-zinc-600">
            For production Kubernetes deployments, a Helm chart is available at{' '}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">infra/helm/bigbluebam/</code>. The chart deploys all
            application services as Deployments with configurable replica counts, HPA (Horizontal Pod Autoscaler)
            support, and Ingress configuration. Data services (PostgreSQL, Redis, MinIO, Qdrant) are expected to be
            provided externally as managed services -- configure them via Helm values. The chart supports zero-downtime
            rolling updates on tag pushes to the main branch.
          </p>
        </div>

        {/* Troubleshooting */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-bold text-zinc-900">Troubleshooting</h2>
          <div className="space-y-4">
            <div>
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Port conflicts</h3>
              <p className="text-sm text-zinc-600">
                If port 80 is already in use, change the published port in docker-compose.yml or set{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">NGINX_PORT</code> in your .env file.
                Internal service ports (4000, 4001, etc.) are not published to the host by default.
              </p>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Migration failures</h3>
              <p className="text-sm text-zinc-600">
                If the migrate service fails, check its logs with{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">docker compose logs migrate</code>. Common causes:
                a modified migration file (checksum mismatch), a syntax error in new SQL, or PostgreSQL not being ready yet.
                The migrate service waits for PostgreSQL health checks before running, but network issues can cause timeouts.
              </p>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Healthcheck failures</h3>
              <p className="text-sm text-zinc-600">
                Services depend on healthcheck-passing data services. If services are stuck in "waiting" state, check that
                PostgreSQL, Redis, and MinIO are healthy with{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">docker compose ps</code>. Increase Docker's
                memory allocation if services are being OOM-killed.
              </p>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Slow first start</h3>
              <p className="text-sm text-zinc-600">
                The first <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">docker compose up</code> builds all images
                from source, which can take 5-10 minutes depending on your machine. Subsequent starts use cached layers and
                are much faster. Pre-built images from GHCR are available for production deployments.
              </p>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">WebSocket connection errors</h3>
              <p className="text-sm text-zinc-600">
                If real-time updates are not working, verify that nginx is correctly proxying WebSocket connections on{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">/b3/ws</code> and{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">/banter/ws</code>. Check that the Redis
                service is running (used for cross-instance pub/sub broadcasting).
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function FaqsContent() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Frequently Asked Questions</h1>
        <p className="mt-3 max-w-2xl text-base text-zinc-600">
          Answers to common questions about BigBlueBam, its architecture, deployment, and usage.
        </p>
      </div>

      <div className="space-y-2">
        {faqs.map((faq, index) => (
          <div key={faq.question} className="rounded-lg border border-zinc-200 bg-white">
            <button
              type="button"
              onClick={() => setOpenIndex(openIndex === index ? null : index)}
              className="flex w-full items-center justify-between px-6 py-4 text-left"
            >
              <span className="pr-4 text-sm font-semibold text-zinc-900">{faq.question}</span>
              {openIndex === index ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
              )}
            </button>
            {openIndex === index && (
              <div className="border-t border-zinc-100 px-6 py-4">
                <p className="text-sm leading-relaxed text-zinc-600">{faq.answer}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-12 rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
        <p className="font-medium text-zinc-800">Still have questions?</p>
        <p className="mt-1">
          Visit the{' '}
          <a href="/#cta" className="font-medium text-primary-600 underline underline-offset-2 hover:text-primary-700">
            contact section
          </a>{' '}
          to get in touch, or use the MCP tools to explore the platform programmatically.
        </p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

// There is no "User Guide" section: the per-app user guide is the Manual at
// /docs, generated from every docs/apps/<app>/help.md (#399). The sidebar links
// there, and an old /docs/reference#user-guide link is sent there too.
type SectionId = 'mcp-tools' | 'api-endpoints' | 'deployment' | 'faqs';
const MANUAL_HREF = '/docs';
const RETIRED_USER_GUIDE_HASH = 'user-guide';

interface SidebarSection {
  id: SectionId;
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
}

const sidebarSections: SidebarSection[] = [
  { id: 'mcp-tools', label: 'MCP Tools', sublabel: `${MCP_TOOL_COUNT} tools`, icon: <Zap className="h-4 w-4" /> },
  { id: 'api-endpoints', label: 'API Endpoints', icon: <Server className="h-4 w-4" /> },
  { id: 'deployment', label: 'Deployment', icon: <Rocket className="h-4 w-4" /> },
  { id: 'faqs', label: 'FAQs', icon: <HelpCircle className="h-4 w-4" /> },
];

function Sidebar({ activeSection, onSectionChange }: { activeSection: SectionId; onSectionChange: (id: SectionId) => void }) {
  return (
    <aside className="hidden w-[260px] shrink-0 border-r border-zinc-200 lg:block">
      <div className="sticky top-16 p-6">
        <div className="mb-6 flex items-center gap-2 text-zinc-900">
          <BookOpen className="h-5 w-5" />
          <span className="text-lg font-bold">Documentation</span>
        </div>
        <nav>
          <ul className="space-y-1">
            {sidebarSections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => onSectionChange(section.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    activeSection === section.id
                      ? 'bg-primary-50 text-primary-700'
                      : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                  }`}
                >
                  <span className={activeSection === section.id ? 'text-primary-600' : 'text-zinc-400'}>
                    {section.icon}
                  </span>
                  {section.label}
                  {section.sublabel && (
                    <span className="ml-auto text-xs text-zinc-400">{section.sublabel}</span>
                  )}
                </button>
              </li>
            ))}
            <li>
              <a
                href={MANUAL_HREF}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              >
                <span className="text-zinc-400">
                  <Users className="h-4 w-4" />
                </span>
                User Manual
                <span className="ml-auto text-xs text-zinc-400">{APP_COUNT_WORDS} apps</span>
              </a>
            </li>
          </ul>
        </nav>

        {activeSection === 'mcp-tools' && (
          <div className="mt-8 border-t border-zinc-200 pt-6">
            <h4 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Products</h4>
            <ul className="space-y-1">
              {allProducts.map((product) => (
                <li key={product.name}>
                  <a
                    href={`#${product.name.toLowerCase()}`}
                    className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                  >
                    <div className={`flex h-5 w-5 items-center justify-center rounded ${product.color}`}>
                      {product.icon}
                    </div>
                    {product.name}
                    <span className="ml-auto text-xs text-zinc-400">{getTotalTools(product)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {activeSection === 'api-endpoints' && (
          <div className="mt-8 border-t border-zinc-200 pt-6">
            <h4 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Services</h4>
            <ul className="space-y-1">
              {allApis.map((api) => (
                <li key={api.name}>
                  <a
                    href={`#api-${api.name.toLowerCase().replace(/\s+/g, '-')}`}
                    className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                  >
                    <div className={`flex h-5 w-5 items-center justify-center rounded ${api.color}`}>
                      <Server className="h-3 w-3" />
                    </div>
                    {api.name}
                    <span className="ml-auto text-xs text-zinc-400">
                      {api.groups.reduce((sum, g) => sum + g.endpoints.length, 0)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function DocsPage() {
  // The retired User Guide tab now lives in the Manual (#399). Navigate there and
  // do not touch the hash meanwhile: a same-document hash change could cancel
  // the pending navigation.
  const [redirectToManual] = useState(() => window.location.hash === `#${RETIRED_USER_GUIDE_HASH}`);
  useEffect(() => {
    if (redirectToManual) window.location.replace(MANUAL_HREF);
  }, [redirectToManual]);

  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const hash = window.location.hash.replace('#', '');
    const validSections: SectionId[] = ['mcp-tools', 'api-endpoints', 'deployment', 'faqs'];
    if (validSections.includes(hash as SectionId)) return hash as SectionId;
    return 'mcp-tools';
  });

  useEffect(() => {
    if (redirectToManual) return;
    window.location.hash = activeSection;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [activeSection, redirectToManual]);

  const renderContent = () => {
    switch (activeSection) {
      case 'mcp-tools':
        return <McpToolsContent />;
      case 'api-endpoints':
        return <ApiEndpointsContent />;
      case 'deployment':
        return <DeploymentContent />;
      case 'faqs':
        return <FaqsContent />;
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Top navbar */}
      <header className="fixed top-0 right-0 left-0 z-50 border-b border-zinc-200 bg-white/80 shadow-sm backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <a href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-sm font-bold text-white">
              B
            </div>
            <span className="text-lg font-bold text-zinc-900">BigBlueBam</span>
          </a>
          <a
            href="/"
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Home
          </a>
        </div>
      </header>

      {/* Layout */}
      <div className="mx-auto flex max-w-7xl pt-16">
        <Sidebar activeSection={activeSection} onSectionChange={setActiveSection} />

        {/* Content */}
        <main className="min-w-0 flex-1 px-6 py-10 lg:px-12">
          {renderContent()}
        </main>
      </div>
    </div>
  );
}
