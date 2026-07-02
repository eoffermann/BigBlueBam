import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, ArrowLeft, BookOpen, Zap, MessageSquare, Compass, FileText, Bot, Server, Users, Rocket, HelpCircle } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  MCP Tool Data                                                      */
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

const bamTools: ToolProduct = {
  name: 'Bam',
  icon: <Zap className="h-4 w-4" />,
  color: 'bg-primary-100 text-primary-700',
  categories: [
    {
      name: 'Tasks',
      tools: [
        { name: 'search_tasks', description: 'Search and filter tasks in a project' },
        { name: 'get_task', description: 'Get detailed information about a specific task' },
        { name: 'create_task', description: 'Create a new task in a project' },
        { name: 'update_task', description: 'Update an existing task' },
        { name: 'move_task', description: 'Move a task to a different phase and/or position on the board' },
        { name: 'delete_task', description: 'Delete a task (destructive action - will ask for confirmation)' },
        { name: 'bulk_update_tasks', description: 'Perform a bulk operation on multiple tasks at once' },
        { name: 'log_time', description: 'Log time spent on a task' },
        { name: 'duplicate_task', description: 'Duplicate an existing task, optionally including its subtasks' },
        { name: 'import_csv', description: 'Import tasks from CSV data into a project' },
      ],
    },
    {
      name: 'Sprints',
      tools: [
        { name: 'list_sprints', description: 'List all sprints for a project' },
        { name: 'create_sprint', description: 'Create a new sprint for a project' },
        { name: 'start_sprint', description: 'Start a planned sprint' },
        { name: 'complete_sprint', description: 'Complete an active sprint' },
        { name: 'get_sprint_report', description: 'Get a sprint report with velocity, completion stats, and burndown data' },
      ],
    },
    {
      name: 'Comments',
      tools: [
        { name: 'list_comments', description: 'List all comments on a task' },
        { name: 'add_comment', description: 'Add a comment to a task' },
      ],
    },
    {
      name: 'Board',
      tools: [
        { name: 'get_board', description: 'Get the full board state for a project, including all phases and their tasks' },
        { name: 'list_phases', description: 'List all phases (columns) for a project' },
        { name: 'create_phase', description: 'Create a new phase (column) in a project board' },
        { name: 'reorder_phases', description: 'Reorder the phases (columns) on a project board' },
      ],
    },
    {
      name: 'Projects',
      tools: [
        { name: 'list_projects', description: 'List all projects the current user has access to' },
        { name: 'get_project', description: 'Get detailed information about a specific project' },
        { name: 'create_project', description: 'Create a new project' },
        { name: 'test_slack_webhook', description: 'Send a test message to the Slack webhook configured for a project' },
        { name: 'disconnect_github_integration', description: 'Remove the GitHub integration from a project' },
      ],
    },
    {
      name: 'Reports',
      tools: [
        { name: 'get_velocity_report', description: 'Get velocity report showing story points completed across recent sprints' },
        { name: 'get_burndown', description: 'Get burndown chart data for a specific sprint' },
        { name: 'get_cumulative_flow', description: 'Get cumulative flow diagram data for a project over a date range' },
        { name: 'get_overdue_tasks', description: 'Get a report of all overdue tasks in a project' },
        { name: 'get_workload', description: 'Get workload distribution report showing task counts and story points per member' },
        { name: 'get_status_distribution', description: 'Get status distribution report showing task counts per phase/status' },
        { name: 'get_cycle_time_report', description: 'Get cycle time metrics for completed tasks in a project' },
        { name: 'get_time_tracking_report', description: 'Get aggregated time entries per user for a project' },
      ],
    },
    {
      name: 'Members',
      tools: [
        { name: 'list_members', description: 'List members of a project or the entire organization' },
        { name: 'get_my_tasks', description: 'Get tasks assigned to the current authenticated user' },
      ],
    },
    {
      name: 'Templates',
      tools: [
        { name: 'list_templates', description: 'List available task templates for a project' },
        { name: 'create_from_template', description: 'Create a task from a template, optionally overriding specific fields' },
      ],
    },
    {
      name: 'Import',
      tools: [
        { name: 'import_github_issues', description: 'Import GitHub issues into a project as tasks' },
        { name: 'suggest_branch_name', description: 'Generate a git branch name suggestion based on a task' },
      ],
    },
    {
      name: 'Me',
      tools: [
        { name: 'get_me', description: 'Get the authenticated user profile' },
        { name: 'update_me', description: "Update the authenticated user's own profile fields" },
        { name: 'list_my_orgs', description: 'List organizations the authenticated user is a member of' },
        { name: 'switch_active_org', description: 'Switch the active organization for the current session' },
        { name: 'change_my_password', description: "Change the authenticated user's password" },
        { name: 'logout', description: 'Invalidate the current session cookie' },
        { name: 'list_my_notifications', description: "Fetch the caller's notification feed (paginated)" },
        { name: 'mark_notification_read', description: 'Mark a single notification as read' },
        { name: 'mark_notifications_read', description: 'Mark several notifications as read in one call' },
        { name: 'mark_all_notifications_read', description: "Mark every notification in the caller's feed as read" },
      ],
    },
    {
      name: 'Platform',
      tools: [
        { name: 'get_platform_settings', description: 'SuperUser only. Fetch platform-wide settings' },
        { name: 'set_public_signup_disabled', description: 'SuperUser only. Toggle the platform-wide public signup kill switch' },
        { name: 'list_beta_signups', description: 'SuperUser only. List notify-me submissions from the public beta-gate form' },
        { name: 'get_public_config', description: 'Read the unauthenticated /public/config' },
        { name: 'submit_beta_signup', description: 'Create a notify-me submission via the public beta-signup endpoint' },
      ],
    },
    {
      name: 'Helpdesk',
      tools: [
        { name: 'list_tickets', description: 'List helpdesk tickets with optional filters' },
        { name: 'get_ticket', description: 'Get detailed information about a helpdesk ticket including messages' },
        { name: 'reply_to_ticket', description: 'Send a message on a helpdesk ticket (public reply or internal note)' },
        { name: 'update_ticket_status', description: 'Update the status of a helpdesk ticket' },
        { name: 'helpdesk_get_public_settings', description: 'Get public helpdesk settings (no auth required)' },
        { name: 'helpdesk_get_settings', description: 'Get full helpdesk configuration (admin only)' },
        { name: 'helpdesk_update_settings', description: 'Update helpdesk settings (admin only)' },
      ],
    },
    {
      name: 'Utility',
      tools: [
        { name: 'get_server_info', description: 'Get MCP server info including version, available tools, and rate limit status' },
        { name: 'confirm_action', description: 'Confirm a destructive action using a two-step confirmation token' },
      ],
    },
  ],
};

const banterTools: ToolProduct = {
  name: 'Banter',
  icon: <MessageSquare className="h-4 w-4" />,
  color: 'bg-violet-100 text-violet-700',
  categories: [
    {
      name: 'Channels',
      tools: [
        { name: 'banter_list_channels', description: 'List all Banter channels the current user has access to' },
        { name: 'banter_get_channel', description: 'Get detailed information about a Banter channel' },
        { name: 'banter_create_channel', description: 'Create a new Banter channel' },
        { name: 'banter_update_channel', description: 'Update a Banter channel name, description, or topic' },
        { name: 'banter_archive_channel', description: 'Archive a Banter channel (reversible)' },
        { name: 'banter_delete_channel', description: 'Delete a Banter channel (destructive - requires confirmation)' },
        { name: 'banter_join_channel', description: 'Join a Banter channel' },
        { name: 'banter_leave_channel', description: 'Leave a Banter channel' },
        { name: 'banter_add_channel_members', description: 'Add one or more members to a Banter channel' },
        { name: 'banter_remove_channel_member', description: 'Remove a member from a Banter channel' },
        { name: 'banter_browse_channels', description: 'Browse available Banter channels (including unjoined public channels)' },
      ],
    },
    {
      name: 'Messages',
      tools: [
        { name: 'banter_list_messages', description: 'List messages in a Banter channel with pagination' },
        { name: 'banter_get_message', description: 'Get a specific Banter message by ID' },
        { name: 'banter_post_message', description: 'Post a new message to a Banter channel' },
        { name: 'banter_edit_message', description: 'Edit an existing Banter message' },
        { name: 'banter_delete_message', description: 'Delete a Banter message (destructive - requires confirmation)' },
        { name: 'banter_react', description: 'Add or remove an emoji reaction on a Banter message' },
        { name: 'banter_pin_message', description: 'Pin a message in a Banter channel' },
        { name: 'banter_unpin_message', description: 'Unpin a message from a Banter channel' },
        { name: 'banter_search_messages', description: 'Search messages across Banter channels' },
      ],
    },
    {
      name: 'Threads',
      tools: [
        { name: 'banter_list_thread_replies', description: 'List replies in a Banter message thread' },
        { name: 'banter_reply_to_thread', description: 'Post a reply in a Banter message thread' },
      ],
    },
    {
      name: 'Direct Messages',
      tools: [
        { name: 'banter_send_dm', description: 'Send a direct message to another user' },
        { name: 'banter_send_group_dm', description: 'Send a group direct message' },
      ],
    },
    {
      name: 'User Groups',
      tools: [
        { name: 'banter_list_user_groups', description: 'List all user groups in the organization' },
        { name: 'banter_create_user_group', description: 'Create a new user group (e.g. @backend-team)' },
        { name: 'banter_update_user_group', description: 'Update a user group name, handle, or description' },
        { name: 'banter_add_group_members', description: 'Add members to a user group' },
        { name: 'banter_remove_group_member', description: 'Remove a member from a user group' },
      ],
    },
    {
      name: 'Calls',
      tools: [
        { name: 'banter_start_call', description: 'Start a new voice/video call in a Banter channel' },
        { name: 'banter_join_call', description: 'Join an active call' },
        { name: 'banter_leave_call', description: 'Leave an active call' },
        { name: 'banter_end_call', description: 'End an active call (destructive - requires confirmation)' },
        { name: 'banter_get_call', description: 'Get details about a specific call' },
        { name: 'banter_list_calls', description: 'List calls in a Banter channel (active and recent)' },
        { name: 'banter_get_transcript', description: 'Get the transcript for a call' },
        { name: 'banter_invite_agent_to_call', description: 'Invite an AI agent to join an active call as a participant' },
        { name: 'banter_post_call_text', description: 'Post a text message in a call channel (for text-mode AI participation)' },
        { name: 'banter_get_active_huddle', description: 'Check if a channel has an active huddle' },
        { name: 'banter_search_transcripts', description: 'Search call transcripts across Banter' },
      ],
    },
    {
      name: 'Cross-Product Sharing',
      tools: [
        { name: 'banter_share_task', description: 'Share a BigBlueBam task as a rich embed in a Banter channel' },
        { name: 'banter_share_sprint', description: 'Share a sprint summary as a rich embed in a Banter channel' },
        { name: 'banter_share_ticket', description: 'Share a Helpdesk ticket as a rich embed in a Banter channel' },
      ],
    },
    {
      name: 'Preferences',
      tools: [
        { name: 'banter_get_unread', description: "Get the current user's unread message summary across all channels" },
        { name: 'banter_get_preferences', description: "Get the user's Banter notification and theme preferences" },
        { name: 'banter_update_preferences', description: "Update the user's Banter notification and theme preferences" },
        { name: 'banter_set_presence', description: "Set the user's presence status in Banter" },
      ],
    },
  ],
};

const beaconTools: ToolProduct = {
  name: 'Beacon',
  icon: <Compass className="h-4 w-4" />,
  color: 'bg-amber-100 text-amber-700',
  categories: [
    {
      name: 'Articles',
      tools: [
        { name: 'beacon_create', description: 'Create a new Beacon (Draft)' },
        { name: 'beacon_list', description: 'List Beacons with optional filters and pagination' },
        { name: 'beacon_get', description: 'Retrieve a single Beacon by ID or slug' },
        { name: 'beacon_update', description: 'Update a Beacon (creates a new version)' },
        { name: 'beacon_retire', description: 'Retire (soft-delete) a Beacon' },
        { name: 'beacon_publish', description: 'Transition a Beacon from Draft to Active' },
        { name: 'beacon_verify', description: 'Record a verification event on a Beacon' },
        { name: 'beacon_challenge', description: 'Flag a Beacon for review (challenge its accuracy)' },
        { name: 'beacon_restore', description: 'Restore an Archived Beacon back to Active status' },
      ],
    },
    {
      name: 'Versions',
      tools: [
        { name: 'beacon_versions', description: 'List the version history of a Beacon' },
        { name: 'beacon_version_get', description: 'Get a specific version of a Beacon' },
      ],
    },
    {
      name: 'Search',
      tools: [
        { name: 'beacon_search', description: 'Hybrid semantic + keyword + graph search across Beacons' },
        { name: 'beacon_suggest', description: 'Typeahead suggestions from the Beacon title/tag index' },
        { name: 'beacon_search_context', description: 'Structured retrieval optimized for agent consumption' },
      ],
    },
    {
      name: 'Governance',
      tools: [
        { name: 'beacon_policy_get', description: 'Get the effective Beacon governance policy for the current scope' },
        { name: 'beacon_policy_set', description: 'Set or update the Beacon governance policy at a given scope level' },
        { name: 'beacon_policy_resolve', description: 'Preview the resolved effective policy (merging org + project levels)' },
      ],
    },
    {
      name: 'Tags & Links',
      tools: [
        { name: 'beacon_tags_list', description: 'List all tags in scope with usage counts' },
        { name: 'beacon_tag_add', description: 'Add one or more tags to a Beacon' },
        { name: 'beacon_tag_remove', description: 'Remove a tag from a Beacon' },
        { name: 'beacon_link_create', description: 'Create a typed link between two Beacons' },
        { name: 'beacon_link_remove', description: 'Remove a link from a Beacon' },
      ],
    },
    {
      name: 'Saved Queries',
      tools: [
        { name: 'beacon_query_save', description: 'Save a named search query configuration for reuse' },
        { name: 'beacon_query_list', description: 'List saved queries (own + shared in scope)' },
        { name: 'beacon_query_get', description: 'Retrieve a saved query by ID' },
        { name: 'beacon_query_delete', description: 'Delete a saved query (owner only)' },
      ],
    },
    {
      name: 'Knowledge Graph',
      tools: [
        { name: 'beacon_graph_neighbors', description: 'Get nodes and edges within N hops of a focal Beacon' },
        { name: 'beacon_graph_hubs', description: 'Get the most-connected Beacons in scope (hub nodes)' },
        { name: 'beacon_graph_recent', description: 'Get recently modified or verified Beacons' },
      ],
    },
  ],
};

const briefTools: ToolProduct = {
  name: 'Brief',
  icon: <FileText className="h-4 w-4" />,
  color: 'bg-emerald-100 text-emerald-700',
  categories: [
    {
      name: 'Documents',
      tools: [
        { name: 'brief_list', description: 'List Brief documents with optional filters and pagination' },
        { name: 'brief_get', description: 'Retrieve a single Brief document by ID or slug' },
        { name: 'brief_create', description: 'Create a new Brief document' },
        { name: 'brief_update', description: 'Update Brief document metadata' },
        { name: 'brief_update_content', description: 'Replace the entire content of a Brief document with new Markdown' },
        { name: 'brief_append_content', description: 'Append Markdown content to the end of a Brief document' },
        { name: 'brief_archive', description: 'Archive a Brief document (soft-delete)' },
        { name: 'brief_restore', description: 'Restore an archived Brief document' },
        { name: 'brief_duplicate', description: 'Duplicate a Brief document, optionally into a different project' },
        { name: 'brief_search', description: 'Search Brief documents by keyword or semantic similarity' },
      ],
    },
    {
      name: 'Comments',
      tools: [
        { name: 'brief_comment_list', description: 'List comments on a Brief document' },
        { name: 'brief_comment_add', description: 'Add a comment to a Brief document' },
        { name: 'brief_comment_resolve', description: 'Toggle the resolved state of a comment' },
      ],
    },
    {
      name: 'Versions',
      tools: [
        { name: 'brief_versions', description: 'List the version history of a Brief document' },
        { name: 'brief_version_get', description: 'Get a specific version of a Brief document' },
        { name: 'brief_version_restore', description: 'Restore a Brief document to a specific previous version' },
      ],
    },
    {
      name: 'Integration',
      tools: [
        { name: 'brief_promote_to_beacon', description: 'Graduate a Brief document to a Beacon knowledge article' },
        { name: 'brief_link_task', description: 'Link a Brief document to a Bam task' },
      ],
    },
  ],
};

const boltTools: ToolProduct = {
  name: 'Bolt',
  icon: <Bot className="h-4 w-4" />,
  color: 'bg-rose-100 text-rose-700',
  categories: [
    {
      name: 'Automations',
      tools: [
        { name: 'bolt_list', description: 'List workflow automations with optional filters and pagination' },
        { name: 'bolt_get', description: 'Get a single automation with its conditions and actions' },
        { name: 'bolt_create', description: 'Create a new workflow automation with trigger, conditions, and actions' },
        { name: 'bolt_update', description: 'Update an existing automation' },
        { name: 'bolt_enable', description: 'Enable a workflow automation' },
        { name: 'bolt_disable', description: 'Disable a workflow automation' },
        { name: 'bolt_delete', description: 'Delete a workflow automation' },
      ],
    },
    {
      name: 'Testing & Execution',
      tools: [
        { name: 'bolt_test', description: 'Test-fire an automation with a simulated event payload' },
        { name: 'bolt_executions', description: 'List execution history for an automation' },
        { name: 'bolt_execution_detail', description: 'Get detailed information about a single execution' },
      ],
    },
    {
      name: 'Discovery',
      tools: [
        { name: 'bolt_events', description: 'List available trigger events, optionally filtered by source' },
        { name: 'bolt_actions', description: 'List available MCP tools that can be used as automation actions' },
      ],
    },
  ],
};

const bearingTools: ToolProduct = {
  name: 'Bearing',
  icon: <Compass className="h-4 w-4" />,
  color: 'bg-indigo-100 text-indigo-700',
  categories: [
    {
      name: 'Periods',
      tools: [
        { name: 'bearing_periods', description: 'List OKR periods with optional filters by status and year' },
        { name: 'bearing_period_get', description: 'Get a single OKR period with aggregated stats' },
      ],
    },
    {
      name: 'Goals',
      tools: [
        { name: 'bearing_goals', description: 'List OKR goals with optional filters by period, scope, owner, and status' },
        { name: 'bearing_goal_get', description: 'Get a single goal with its key results and progress details' },
        { name: 'bearing_goal_create', description: 'Create a new OKR goal within a period' },
        { name: 'bearing_goal_update', description: 'Update an existing goal (provide only the fields to change)' },
      ],
    },
    {
      name: 'Key Results',
      tools: [
        { name: 'bearing_kr_create', description: 'Create a key result under a goal' },
        { name: 'bearing_kr_update', description: 'Update a key result value or metadata (current_value posts a check-in)' },
        { name: 'bearing_kr_link', description: 'Link a key result to a Bam entity for automatic progress tracking' },
      ],
    },
    {
      name: 'Updates',
      tools: [
        { name: 'bearing_update_post', description: 'Post a status update on a goal' },
      ],
    },
    {
      name: 'Reports',
      tools: [
        { name: 'bearing_report', description: 'Generate a period summary, at-risk, or owner report' },
        { name: 'bearing_at_risk', description: 'Quick check: list all at-risk or behind goals across the organization' },
      ],
    },
  ],
};

const boardTools: ToolProduct = {
  name: 'Board',
  icon: <Zap className="h-4 w-4" />,
  color: 'bg-cyan-100 text-cyan-700',
  categories: [
    {
      name: 'Rooms',
      tools: [
        { name: 'board_list', description: 'List whiteboard rooms with optional filters and pagination' },
        { name: 'board_get', description: 'Get a single whiteboard room by ID with participant info' },
        { name: 'board_create', description: 'Create a new whiteboard room in a project' },
        { name: 'board_update', description: 'Update room name, description, or settings' },
        { name: 'board_delete', description: 'Delete a whiteboard room (destructive - requires confirmation)' },
      ],
    },
    {
      name: 'Shapes',
      tools: [
        { name: 'board_shapes', description: 'List all shapes on a whiteboard canvas' },
        { name: 'board_shape_add', description: 'Add a shape (sticky, rectangle, text, arrow, etc.) to the canvas' },
        { name: 'board_shape_update', description: 'Update shape properties (position, size, color, text)' },
        { name: 'board_shape_remove', description: 'Remove a shape from the canvas' },
      ],
    },
    {
      name: 'Canvas',
      tools: [
        { name: 'board_canvas_read', description: 'Get the full canvas state in an AI-readable structured format' },
        { name: 'board_canvas_snapshot', description: 'Generate a visual snapshot of the current canvas' },
      ],
    },
    {
      name: 'Assets & Pipeline',
      tools: [
        { name: 'board_asset_upload', description: 'Upload an image or file to the whiteboard canvas' },
        { name: 'board_sticky_to_task', description: 'Convert a sticky note into a Bam task with metadata carry-over' },
        { name: 'board_embed', description: 'Embed a cross-product item (task, beacon, brief, goal) on the canvas' },
      ],
    },
  ],
};

const bondTools: ToolProduct = {
  name: 'Bond',
  icon: <Zap className="h-4 w-4" />,
  color: 'bg-pink-100 text-pink-700',
  categories: [
    {
      name: 'Contacts',
      tools: [
        { name: 'bond_contact_list', description: 'List contacts with optional filters (company, tag, search) and pagination' },
        { name: 'bond_contact_get', description: 'Get detailed information about a single contact' },
        { name: 'bond_contact_create', description: 'Create a new contact with name, email, phone, company, and custom fields' },
        { name: 'bond_contact_update', description: 'Update an existing contact record' },
      ],
    },
    {
      name: 'Companies',
      tools: [
        { name: 'bond_company_list', description: 'List companies with optional filters and pagination' },
        { name: 'bond_company_get', description: 'Get detailed information about a company including linked contacts' },
        { name: 'bond_company_create', description: 'Create a new company record' },
        { name: 'bond_company_update', description: 'Update an existing company record' },
      ],
    },
    {
      name: 'Deals',
      tools: [
        { name: 'bond_deal_list', description: 'List deals with optional pipeline, stage, owner, and value filters' },
        { name: 'bond_deal_get', description: 'Get detailed information about a deal including linked contacts and activities' },
        { name: 'bond_deal_create', description: 'Create a new deal with value, stage, expected close date, and linked contacts' },
        { name: 'bond_deal_update', description: 'Update deal fields (value, stage, probability, owner, etc.)' },
        { name: 'bond_deal_move', description: 'Move a deal to a different pipeline stage' },
      ],
    },
    {
      name: 'Activities',
      tools: [
        { name: 'bond_activity_log', description: 'Log an activity (call, email, meeting, note, task) against a contact, company, or deal' },
        { name: 'bond_activity_list', description: 'List activities for a contact, company, or deal with date and type filters' },
      ],
    },
    {
      name: 'Pipeline & Reports',
      tools: [
        { name: 'bond_pipeline_get', description: 'Get pipeline configuration with stages, colors, and ordering' },
        { name: 'bond_pipeline_report', description: 'Generate pipeline report (conversion rates, avg deal size, stage duration, forecast)' },
      ],
    },
    {
      name: 'Search',
      tools: [
        { name: 'bond_search', description: 'Cross-entity search across contacts, companies, deals, and activities' },
      ],
    },
  ],
};

const allProducts: ToolProduct[] = [bamTools, banterTools, beaconTools, briefTools, boltTools, bearingTools, boardTools, bondTools];

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
    answer: 'BigBlueBam ships with nineteen integrated applications: Bam (Kanban project management with sprints), Banter (real-time messaging with channels, DMs, threads, voice/video calls, and scheduled posts), Beacon (knowledge base with semantic search and a knowledge graph), Brief (collaborative WYSIWYG documents), Bolt (WHEN/IF/THEN workflow automations with runtime observability), Bearing (goals and OKR tracking), Board (infinite-canvas visual collaboration whiteboards with real-time editing and audio conferencing), Bond (CRM with visual deal pipeline, contact and company management, activity tracking, and dedupe primitives), Blast (email campaigns with templates, segments, and analytics), Bill (invoicing, expenses, PDF generation, and recurring billing), Blank (forms with conditional logic routing), Blueprint (structured-diagram editor with typed graph nodes and auto-layout), Book (scheduling and public booking pages), Bench (analytics dashboards and scheduled reports), Bureau (virtual office with rooms, presence, and knock-to-enter), Bin (digital asset manager and structured-data editor backed by object storage), Bay (media review and approval with annotations and public guest links), Blip (telemetry and event tracking), and Helpdesk (customer support ticket portal with similar-ticket lookup). All nineteen apps share a single authentication system, cross-link to each other seamlessly, and surface into a single cross-app search, composite subject views, and a durable entity-links table.',
  },
  {
    question: 'What is the difference between Beacon and Brief?',
    answer: 'Beacon is the team knowledge base: it stores verified, canonical information articles that go through a publish-verify-challenge lifecycle with governance policies and freshness tracking. Brief is the collaborative document editor for drafting, note-taking, meeting minutes, and specs -- documents that may still be evolving. When a Brief document stabilizes and becomes authoritative, you can promote it to a Beacon article with one click.',
  },
  {
    question: 'How do AI agents work with BigBlueBam?',
    answer: 'BigBlueBam exposes 804 MCP (Model Context Protocol) tools on a dedicated server endpoint at /mcp/. Any MCP-compatible AI agent -- Claude, GPT, or custom agents -- can connect and manage tasks, post messages, search the knowledge base, write documents, create automations, track goals, collaborate on visual whiteboards, manage the CRM pipeline, invoice clients, run email campaigns, build dashboards, and schedule meetings. Destructive actions require a two-step confirmation flow with Redis-backed tokens to prevent accidental data loss. Service-account agents run behind a fail-closed policy gate (kill switches plus per-agent tool allowlists) and a first-class approval queue routes human-gated actions through a durable inbox. The MCP server supports Streamable HTTP, SSE, and stdio transports.',
  },
  {
    question: 'What is MCP?',
    answer: 'MCP stands for Model Context Protocol, an open standard for connecting AI models to external tools and data sources. Instead of building custom integrations for each AI provider, BigBlueBam implements MCP once and any compliant agent can use all 804 tools. You can learn more at modelcontextprotocol.io.',
  },
  {
    question: 'Can I use my own LLM?',
    answer: 'Yes. BigBlueBam supports configurable LLM providers in Settings. You can connect OpenAI, Anthropic, Azure OpenAI, or any OpenAI-compatible API (such as a local Ollama instance). The platform resolves which provider to use based on capability (embedding, chat, triage) and you can test connectivity from the settings page before enabling it for production use.',
  },
  {
    question: 'Is BigBlueBam open source?',
    answer: 'BigBlueBam is source-available on GitHub. The full codebase -- frontends, nineteen app APIs, Docker Compose stack, Helm chart, and migrations -- is in a single monorepo. You can self-host it on your own infrastructure with no external dependencies beyond the Docker images. Check the repository for the specific license terms.',
  },
  {
    question: 'How do I deploy BigBlueBam?',
    answer: 'The quickest way is to clone the repository, copy .env.example to .env, fill in your secrets, and run docker compose up -d. This starts a full stack including PostgreSQL, Redis, MinIO, Qdrant, all nineteen app APIs, their frontends, the MCP server, and a background worker. Everything is accessible through a single nginx reverse proxy on port 80. For production, a Helm chart is provided at infra/helm/ for Kubernetes deployment. Operators can also skip the CLI admin prompt entirely and have the first visitor create the SuperUser account from the site via the new /b3/bootstrap page.',
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
          BigBlueBam exposes <strong>804 MCP tools</strong> across 19 products, enabling AI agents
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

function UserGuideContent() {
  return (
    <>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">User Guide</h1>
        <p className="mt-3 max-w-2xl text-base text-zinc-600">
          A practical guide to using BigBlueBam's nineteen integrated applications. Whether you are managing sprints,
          messaging your team, building a knowledge base, writing documents, automating workflows, collaborating on whiteboards, managing your CRM pipeline, or handling
          customer support tickets, this guide covers the essentials.
        </p>
      </div>

      {/* Getting Started */}
      <div className="mb-12">
        <h2 className="mb-6 text-2xl font-bold text-zinc-900">Getting Started</h2>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">First-Time Setup</h3>
            <p className="mb-3 text-sm text-zinc-600">
              After deploying BigBlueBam with Docker Compose, you need to create an initial admin account. Run the
              create-admin CLI command against the API container, providing an email, password, name, and organization
              name. This creates both the first organization and the first user with owner permissions. Once created,
              navigate to your domain in a browser and log in.
            </p>
            <div className="rounded-md bg-zinc-50 p-3">
              <code className="text-xs text-zinc-700">
                docker compose exec api node dist/cli.js create-admin --email admin@example.com --password your-password --name "Admin" --org "My Org"
              </code>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Navigation Overview</h3>
            <p className="mb-3 text-sm text-zinc-600">
              BigBlueBam uses a cross-app navigation system with colored pills at the top of the screen. Each pill
              represents one of the nineteen apps: Bam, Banter, Beacon, Brief, Bolt, Bearing, Board, Bond,
              Blast, Bill, Blank, Blueprint, Book, Bench, Bureau, Bin, Bay, Blip, and Helpdesk. Click any pill to switch apps without losing your place. Within each app, a collapsible
              sidebar provides contextual navigation -- projects in Bam, channels in Banter, folders in Brief, and so on.
            </p>
            <p className="text-sm text-zinc-600">
              The <strong>Command Palette</strong> is available everywhere with <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-xs font-medium">Ctrl+K</kbd> (or <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-xs font-medium">Cmd+K</kbd> on macOS).
              It provides fuzzy search across tasks, projects, channels, beacons, documents, and navigation commands.
              Power users can navigate the entire platform without ever touching the mouse.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Organizations and Projects</h3>
            <p className="text-sm text-zinc-600">
              Everything in BigBlueBam is scoped to an organization. Users can belong to multiple organizations and
              switch between them from the org switcher in the top-left corner. Within an organization, you create
              projects to organize work. Each project has its own board with configurable phases (columns), labels,
              epics, custom fields, and team members with role-based permissions (viewer, member, admin, owner).
            </p>
          </div>
        </div>
      </div>

      {/* Bam */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
            <Zap className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Bam -- Project Management</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Creating and Managing Tasks</h3>
            <p className="mb-3 text-sm text-zinc-600">
              Tasks are the core unit of work in Bam. Create a task by clicking the "+" button in any phase column on the
              board or using the Command Palette. Every task has a title, optional description (rich text with Tiptap),
              assignee, priority (urgent, high, medium, low, none), story points, labels, epic, due date, and custom
              fields defined at the project level. Tasks can have subtasks for breaking down work into smaller pieces.
            </p>
            <p className="text-sm text-zinc-600">
              Use <strong>bulk operations</strong> to update, move, or delete multiple tasks at once. Select tasks with checkboxes
              and use the bulk action bar that appears at the bottom of the screen.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Using the Kanban Board</h3>
            <p className="mb-3 text-sm text-zinc-600">
              The board is the primary view in Bam. Each column represents a phase (e.g., Backlog, To Do, In Progress,
              Review, Done). Drag and drop task cards between columns to update their status. Columns can have WIP
              (Work In Progress) limits that visually highlight when a phase is over capacity. Phases are fully
              configurable -- add, remove, rename, and reorder them from the board settings.
            </p>
            <p className="text-sm text-zinc-600">
              Task positions use float values for cheap reordering without renumbering siblings, so dragging a card
              between two others is always a single lightweight update.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Views: Board, List, Timeline, Calendar, Workload</h3>
            <p className="text-sm text-zinc-600">
              Bam offers five views for looking at your project data. The <strong>Board</strong> view is the classic Kanban
              layout. <strong>List</strong> view shows tasks in a sortable, filterable table. <strong>Timeline</strong> view
              displays tasks with start and due dates on a Gantt-style chart. <strong>Calendar</strong> view plots tasks on
              a month/week calendar by due date. <strong>Workload</strong> view shows how story points and task counts are
              distributed across team members, helping you balance the load. All views share the same filter and sort
              controls, and you can save combinations as <strong>Saved Views</strong> for quick access.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Swimlanes</h3>
            <p className="text-sm text-zinc-600">
              On the Board view, you can group tasks into horizontal swimlanes by assignee, priority, epic, label, or
              sprint. This turns the board into a matrix where each row represents a grouping value and each column is
              still a phase. Swimlanes are especially useful for standup meetings (group by assignee) or for tracking
              work across epics.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Sprint Management</h3>
            <p className="mb-3 text-sm text-zinc-600">
              Sprints are time-boxed iterations, typically 1-4 weeks. Create a sprint from the Sprints panel, set a name,
              goal, start date, and end date. Assign tasks to the sprint by dragging them into the sprint scope or using
              the task detail drawer. When ready, start the sprint -- only one sprint can be active at a time per project.
            </p>
            <p className="text-sm text-zinc-600">
              When you complete a sprint, the carry-forward dialog shows all incomplete tasks. You choose which to carry
              forward into the next sprint (they get a carry-forward badge and counter) and which to return to the backlog.
              Sprint reports include velocity charts, burndown data, and completion statistics.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Task Detail Drawer</h3>
            <p className="text-sm text-zinc-600">
              Click any task card to open the detail drawer on the right side of the screen. The drawer shows the full
              task description (editable rich text), subtasks, attachments (drag-and-drop upload), comments (threaded,
              with emoji reactions), time entries, activity log, and all metadata fields. You can edit any field inline
              without leaving the drawer. The activity log shows every change ever made to the task, who made it, and when.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Project Dashboard and Analytics</h3>
            <p className="text-sm text-zinc-600">
              Each project has a dashboard with key metrics: velocity across recent sprints, status distribution
              (how many tasks in each phase), overdue task count, cycle time trends, and workload balance. Charts are
              interactive and update in real-time. You can also generate reports for specific date ranges and export
              data as CSV.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">My Work</h3>
            <p className="text-sm text-zinc-600">
              The "My Work" view aggregates all tasks assigned to you across every project in the organization into a
              single view. It shows tasks grouped by project with their current status, priority, and due date. This is
              the quickest way to see everything on your plate without switching between projects.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">People Management and Roles</h3>
            <p className="text-sm text-zinc-600">
              User and member management is accessed from the People page (not under Settings). Organization admins and
              owners can invite users, assign org-level roles, and manage API keys and sessions. At the project level,
              members can be assigned viewer, member, admin, or owner roles. The People page has tabbed user-detail
              pages covering profile, projects, access (API keys, sessions, passwords), and activity history.
            </p>
          </div>
        </div>
      </div>

      {/* Helpdesk */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
            <HelpCircle className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Helpdesk -- Customer Support</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">How Customer Tickets Flow</h3>
            <p className="text-sm text-zinc-600">
              The Helpdesk presents a public-facing portal where customers submit support tickets without needing a
              BigBlueBam account. They authenticate as guests with their email and can track their ticket status. On the
              agent side, tickets appear in a queue with priority, status, and category filters. Agents can respond with
              public replies (visible to the customer) or internal notes (visible only to the team). Tickets can be
              converted into Bam tasks with one click, linking the ticket to a project for tracking.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">AI Triage</h3>
            <p className="text-sm text-zinc-600">
              When an LLM provider is configured, the Helpdesk can automatically triage incoming tickets. AI triage
              analyzes the ticket content against your knowledge base (Beacon) and suggests a priority, category, and
              assignee. Agents can accept or override the suggestions. The AI can also suggest reply drafts based on
              relevant Beacon articles, reducing response time for common questions.
            </p>
          </div>
        </div>
      </div>

      {/* Beacon */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
            <Compass className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Beacon -- Knowledge Base</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Creating and Publishing Beacons</h3>
            <p className="text-sm text-zinc-600">
              A "beacon" is a knowledge article -- a canonical piece of information your team relies on. Create a beacon
              from the Beacon home page, write your content using the rich text editor, add tags for categorization, and
              publish when ready. Beacons follow a lifecycle: Draft (being written), Active (published and current),
              Stale (past its verification deadline), Challenged (flagged for review), Archived (soft-deleted), and
              Retired (permanently removed from active use). Only Active beacons appear in search results by default.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Verification Lifecycle and Freshness</h3>
            <p className="text-sm text-zinc-600">
              Beacons have a verification cadence set by governance policies. An owner or designated verifier periodically
              confirms that the content is still accurate, which resets the freshness clock. When a beacon goes past its
              verification deadline, it enters a Stale state and surfaces in dashboards and notifications. Anyone can
              "challenge" a beacon they believe is inaccurate, which flags it for the owner to review and either update
              or re-verify.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Knowledge Graph Explorer</h3>
            <p className="text-sm text-zinc-600">
              Beacons are connected through typed links (e.g., "depends on," "supersedes," "related to"), forming a
              knowledge graph. The Graph Explorer visualizes these connections as an interactive node-edge diagram. You
              can explore neighbors within N hops of any beacon, find hub nodes (the most-connected articles), and
              discover relationships you might not have known existed. The graph is a powerful tool for understanding
              how knowledge in your organization is interconnected.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Semantic Search</h3>
            <p className="text-sm text-zinc-600">
              Beacon search combines three retrieval strategies: keyword matching (traditional full-text search),
              semantic similarity (vector embeddings via Qdrant), and graph traversal (following links from matching
              nodes). This hybrid approach means you can search by exact terms, by meaning, or by relationship. Results
              are ranked by a weighted combination of all three signals. Saved queries let you bookmark frequently used
              search configurations.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Governance Policies</h3>
            <p className="text-sm text-zinc-600">
              Governance policies control verification cadence, who can publish, and freshness thresholds. Policies
              can be set at the organization level (applies to all projects) or overridden at the project level. The
              policy resolution system merges levels, so project-specific settings take precedence over org defaults.
              This lets engineering teams have stricter verification requirements than, say, a marketing team's
              internal wiki.
            </p>
          </div>
        </div>
      </div>

      {/* Brief */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
            <FileText className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Brief -- Documents</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Creating Documents from Templates</h3>
            <p className="text-sm text-zinc-600">
              Brief documents can be created from scratch or from templates. Templates provide pre-filled structure for
              common document types like meeting notes, RFCs, sprint retrospectives, or onboarding guides. Organization
              admins can create templates from any existing document. When creating from a template, the structure is
              copied but you can customize everything before saving.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Using the WYSIWYG Editor</h3>
            <p className="mb-3 text-sm text-zinc-600">
              The Brief editor is built on Tiptap, a modern ProseMirror-based editor. The floating toolbar appears when
              you select text and offers formatting options: bold, italic, strikethrough, code, links, headings (H1-H3),
              bullet lists, numbered lists, checklists, blockquotes, code blocks with syntax highlighting, tables,
              images, and horizontal rules.
            </p>
            <p className="text-sm text-zinc-600">
              <strong>Slash commands</strong> are available by typing "/" at the start of a line. This opens a menu for
              inserting blocks like tables, code blocks, images, task embeds (from Bam), beacon references, and more.
              Keyboard shortcuts follow standard conventions (Ctrl+B for bold, Ctrl+I for italic, etc.).
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Table of Contents</h3>
            <p className="text-sm text-zinc-600">
              Long documents automatically generate a Table of Contents from headings. The TOC appears in the sidebar
              and updates as you edit. Click any heading in the TOC to scroll directly to that section. This makes
              navigating lengthy specs, runbooks, and guides effortless.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Version History</h3>
            <p className="text-sm text-zinc-600">
              Every save creates a new version of the document. The version history panel shows all versions with
              timestamps, authors, and change summaries. You can view any previous version, compare differences, and
              restore a document to a prior version with one click. Restoring creates a new version (so nothing is
              ever lost).
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Inline Comments</h3>
            <p className="text-sm text-zinc-600">
              Select any text in a document and add an inline comment, similar to Google Docs. Comments appear as
              highlighted regions in the text with a comment thread in the sidebar. Team members can reply to comments
              and mark them as resolved when the feedback has been addressed. Resolved comments collapse but remain
              accessible for reference.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Promoting to Beacon</h3>
            <p className="text-sm text-zinc-600">
              When a Brief document has stabilized and contains authoritative information that the team should rely on,
              you can promote it to a Beacon article with one click. This copies the content into the Beacon system
              where it enters the verification lifecycle, gets indexed for semantic search, and becomes part of the
              knowledge graph. The original Brief document retains a link to the resulting Beacon.
            </p>
          </div>
        </div>
      </div>

      {/* Bolt */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 text-rose-700">
            <Bot className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Bolt -- Automation</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Creating Automations (WHEN / IF / THEN)</h3>
            <p className="text-sm text-zinc-600">
              Every Bolt automation follows a three-part pattern. <strong>WHEN</strong> defines the trigger event -- for
              example, "when a task moves to the Done phase" or "when a new message is posted in a channel."
              <strong> IF</strong> adds optional conditions that filter when the automation fires -- for example, "if the
              task has the label 'bug'" or "if the message contains '@urgent'." <strong>THEN</strong> defines one or more
              actions to execute -- for example, "post a message in the #releases channel" or "create a Beacon article."
              Actions are MCP tools, which means automations have access to the full 804-tool catalog.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Trigger Events and Conditions</h3>
            <p className="mb-3 text-sm text-zinc-600">
              Bolt supports trigger events from all BigBlueBam products: task created, task updated, task moved, sprint
              started, sprint completed, message posted, beacon published, beacon challenged, document created, ticket
              submitted, and many more. The event discovery API lists all available events grouped by source product.
            </p>
            <p className="text-sm text-zinc-600">
              Conditions use a simple expression syntax that can check event payload fields. You can combine multiple
              conditions with AND/OR logic. For example: "task.priority = 'urgent' AND task.labels CONTAINS 'production'."
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">MCP Tool Actions with Template Variables</h3>
            <p className="text-sm text-zinc-600">
              Actions are MCP tool calls with parameters that can reference event data using template variables. For
              example, an action that posts a Banter message might use{' '}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">{'{{task.title}}'}</code> and{' '}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">{'{{task.assignee.name}}'}</code> in the
              message body. Template variables are resolved at execution time from the event payload. You can chain
              multiple actions in sequence -- each action runs after the previous one completes.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Testing Automations</h3>
            <p className="text-sm text-zinc-600">
              Before enabling an automation for production, use the Test button to simulate it. Testing sends a
              synthetic event payload through the automation's conditions and actions in a dry-run mode. The test
              result shows which conditions matched, which actions would execute, and what the resolved template
              variables look like. This lets you debug your automation without triggering real side effects.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Execution Log</h3>
            <p className="text-sm text-zinc-600">
              Every automation execution is logged with the trigger event, condition evaluation results, action outcomes
              (success or failure), timing information, and any error messages. The execution log is accessible from the
              automation detail page and provides a full audit trail. Failed executions show the exact error and the
              step that failed, making debugging straightforward.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Using Templates</h3>
            <p className="text-sm text-zinc-600">
              Bolt comes with pre-built automation templates for common workflows: notify a channel when a sprint starts,
              auto-assign tickets based on category, create a recap Beacon when a sprint completes, and more. Templates
              are a starting point -- create an automation from a template and then customize the conditions, actions, and
              parameters to fit your team's workflow.
            </p>
          </div>
        </div>
      </div>

      {/* Bearing */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
            <Compass className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Bearing -- Goals & OKRs</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Setting Up OKR Periods</h3>
            <p className="text-sm text-zinc-600">
              Bearing organizes goals into time-boxed periods -- quarters, halves, annual, monthly, or custom date ranges.
              Navigate to the Bearing app and create a period first. Periods move through three statuses: planning (goals can
              be drafted and refined), active (the team is executing), and completed (final scores are locked in). Only
              organization admins can create and manage periods.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Creating Goals and Key Results</h3>
            <p className="text-sm text-zinc-600">
              Within a period, create goals (objectives) that describe what you want to achieve. Each goal can be scoped
              to the organization, a team, a project, or an individual. Under each goal, add measurable key results with
              target values, metric types (number, percentage, currency, boolean), and a direction (increase or decrease).
              Key results track progress from a start value toward a target value.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Linking Key Results to Bam Tasks</h3>
            <p className="text-sm text-zinc-600">
              Key results can be linked to Bam entities -- epics, projects, sprints, or individual tasks -- for automatic
              progress tracking. When a linked task completes or a sprint closes, the key result's current value updates
              automatically. This eliminates manual progress updates and ensures goals reflect the actual state of work.
              You can also set key results to manual mode and record value check-ins directly.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Status Tracking and At-Risk Detection</h3>
            <p className="text-sm text-zinc-600">
              Goals carry a status: draft, on_track, at_risk, behind, achieved, or missed. The system automatically
              flags goals as at-risk or behind when progress falls below the expected pace for the current point in the
              period. You can override the computed status manually, and post status updates with commentary to keep
              stakeholders informed. Watchers receive notifications when goal status changes.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Reports</h3>
            <p className="text-sm text-zinc-600">
              Bearing provides three report types: period reports (summary of all goals in a period with completion
              rates), at-risk reports (all goals currently flagged as at-risk or behind across the organization), and
              owner reports (all goals owned by a specific user). Reports can be generated via the UI or through
              30 MCP tools that let AI agents produce reports, flag risks, and share summaries in Banter channels.
            </p>
          </div>
        </div>
      </div>

      {/* Board */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-700">
            <Zap className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Board -- Visual Collaboration</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Whiteboard Rooms</h3>
            <p className="text-sm text-zinc-600">
              Board organizes canvases into rooms, each scoped to a project. Create a room from the Board home page,
              give it a name and optional description, and start collaborating. Rooms can be created from scratch or
              from one of 10 built-in templates (retrospective, brainstorm, user story map, kanban, etc.). Each room
              has its own infinite canvas, side chat, and optional audio conferencing session.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Infinite Canvas</h3>
            <p className="text-sm text-zinc-600">
              The canvas is built on tldraw and supports shapes, sticky notes, freehand drawing, text blocks, arrows,
              images, and embeds. Zoom in and out with scroll or pinch-to-zoom on touch devices. Pan with middle-click
              drag or two-finger swipe. The canvas is truly infinite -- there are no boundaries. Shapes can be grouped,
              aligned, distributed, and locked.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Real-Time Collaboration and Audio</h3>
            <p className="text-sm text-zinc-600">
              Multiple users can edit the same canvas simultaneously with CRDT-based conflict resolution. Each
              participant sees live cursors and presence indicators showing who is on the board. Built-in audio
              conferencing via LiveKit lets participants talk while collaborating -- no need to open a separate call
              in Banter. The side chat panel provides persistent text messaging per room for sharing links, notes,
              and decisions alongside the canvas.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Sticky-to-Task Pipeline</h3>
            <p className="text-sm text-zinc-600">
              During brainstorming sessions, ideas captured as sticky notes can be converted into tracked Bam tasks
              with a single click. The sticky note title becomes the task title, the body becomes the description,
              and the color maps to a priority or label. You can also embed existing Bam tasks, Beacon articles,
              Brief documents, and Bearing goals directly onto the canvas as interactive cards that link back to the
              source item.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">AI Canvas Analysis</h3>
            <p className="text-sm text-zinc-600">
              Board exposes 40 MCP tools that let AI agents interact with whiteboards programmatically. Agents can
              read the full canvas state as structured data, add and arrange shapes, generate snapshots, upload
              assets, convert stickies to tasks, and embed cross-product content. This enables workflows like
              "analyze this retrospective board and summarize the themes" or "create a task for each action item
              sticky."
            </p>
          </div>
        </div>
      </div>

      {/* Bond */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-pink-100 text-pink-700">
            <Zap className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Bond -- CRM</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Pipeline Board</h3>
            <p className="text-sm text-zinc-600">
              Bond organizes sales work around a visual pipeline board. Deals appear as cards on a Kanban-style
              board where each column represents a pipeline stage (e.g., Prospecting, Qualified, Proposal, Negotiation,
              Closed Won, Closed Lost). Drag deals between stages to advance them through the pipeline. Each stage
              shows the weighted pipeline value so you can see your forecast at a glance. Pipelines are fully
              configurable -- add, rename, reorder, and color-code stages to match your sales process.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Contacts and Companies</h3>
            <p className="text-sm text-zinc-600">
              Contacts are people you do business with. Each contact record stores name, email, phone, job title,
              company association, tags, custom fields, and a complete activity timeline. Companies group contacts
              into organizations with their own metadata (industry, size, website, address). Bond detects potential
              duplicates and lets you merge contact records to keep your database clean. Contacts and companies link
              to deals, so you always know who is involved in each opportunity.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Deals and Activity Tracking</h3>
            <p className="text-sm text-zinc-600">
              A deal represents a sales opportunity with a value, expected close date, probability, pipeline stage,
              owner, and linked contacts. The deal detail page shows the full activity timeline -- calls, emails,
              meetings, notes, and tasks -- so anyone on the team can pick up context instantly. Log activities
              against contacts, companies, or deals with a single click. Stage history tracks every pipeline
              transition with timestamps and the user who made the change.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Cross-Product Integration</h3>
            <p className="text-sm text-zinc-600">
              Bond integrates deeply with the rest of the BigBlueBam suite. Link a closed-won deal to a Bam project
              to kick off onboarding work. Reference Helpdesk tickets on a deal to track support interactions with
              prospects. Attach Beacon knowledge articles that helped close the deal. When a deal closes, Bolt
              automations can create the implementation project, notify the team via Banter, and generate a customer
              knowledge Beacon -- all without manual intervention.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Pipeline Reports</h3>
            <p className="text-sm text-zinc-600">
              Bond provides pipeline analytics including conversion rates between stages, average deal size,
              average stage duration, revenue forecast (weighted by deal probability), and win/loss analysis.
              Reports can be filtered by date range, pipeline, owner, and company. AI agents can generate and
              share pipeline reports in Banter channels through 69 dedicated MCP tools, including a
              contact upsert-by-email endpoint and dedupe primitives that surface likely duplicate
              contacts with confidence scores.
            </p>
          </div>
        </div>
      </div>

      {/* Banter */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
            <MessageSquare className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Banter -- Messaging</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Channels, DMs, and Threads</h3>
            <p className="text-sm text-zinc-600">
              Banter organizes conversations into channels (public or private), direct messages (1:1), and group DMs.
              Public channels are discoverable and joinable by any org member; private channels require an invitation.
              Any message in a channel can start a thread for focused side conversations without cluttering the main
              channel. Messages support rich text formatting, emoji reactions, file attachments, and cross-product embeds
              (share a Bam task, sprint summary, or Helpdesk ticket as a rich card in any channel).
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Search</h3>
            <p className="text-sm text-zinc-600">
              Banter search lets you find messages across all channels you have access to. Search by keywords, sender,
              date range, or channel. Results are ranked by relevance and show context around the matching text. You can
              also search call transcripts separately if your team uses voice/video calls with transcription enabled.
              Bookmark important messages for quick reference later.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Scheduled Posts and Quiet Hours</h3>
            <p className="text-sm text-zinc-600">
              Every channel can carry a quiet-hours policy (IANA timezone, allowed hours, optional
              weekday-only, optional urgency-override consent flag). Immediate posts that land in a
              quiet window return 409 unless the caller explicitly defers (auto-converts to a
              scheduled post at the next allowed time) or the channel policy grants an urgency
              override. Scheduled posts are persisted to banter_scheduled_messages and fire via a
              BullMQ delayed job; a startup reconciler re-enqueues any pending rows that survived
              a Redis flush. The banter_schedule_post MCP tool is the clean-named caller for
              deferred sends.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Agent Pattern Subscriptions</h3>
            <p className="text-sm text-zinc-600">
              Agent-class callers can register pattern subscriptions on a channel (keyword,
              interrogative, mention, or admin-only regex). A worker consumes banter message
              events, evaluates active subscriptions, and fires a banter.message.matched Bolt event
              per match so downstream rules can route the signal. Channels gate who may subscribe
              via agent_subscription_policy, rate-limits are per-subscription-per-hour plus a
              per-subscriber ceiling, and a can_access preflight runs before any event emits so
              private-channel content cannot leak into public routing fan-outs.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Admin Settings</h3>
            <p className="text-sm text-zinc-600">
              Workspace admins can configure Banter settings including default notification preferences, message
              retention policies, who can create channels, file upload limits, and external webhook integrations.
              User groups (like @backend-team or @design) can be created to mention and notify groups of people at once.
              Presence status (online, away, do not disturb, offline) is shown next to user avatars across the platform.
            </p>
          </div>
        </div>
      </div>

      {/* Agentic Platform */}
      <div className="mb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
            <Bot className="h-4 w-4" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900">Agentic Platform -- Cross-App Capabilities</h2>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Agent Identity, Audit, and Heartbeat</h3>
            <p className="text-sm text-zinc-600">
              Every user carries an actor_type (human, agent, service). activity_log rows mirror
              the actor_type at write time so queries like "everything an agent did in the last
              24 hours" run without email-pattern inference. Agent runners call agent_heartbeat
              on a schedule; the platform tracks last_heartbeat_at and surface liveness alongside
              the runner's advertised capabilities. agent_audit and agent_self_report round out
              the self-observation surface so an agent can produce its own daily digest.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Approval Queues (agent_proposals)</h3>
            <p className="text-sm text-zinc-600">
              Durable proposal registry replaces ad-hoc Banter-thread HITL. Agents call
              proposal_create with a proposed action, payload, and approver; humans see
              everything waiting on them via proposal_list; proposal_decide records the verdict
              and fires proposal.created and proposal.decided Bolt events. The confirm_action
              two-step token flow runs in Redis with a dynamic TTL (5 minutes for human approvers,
              60 seconds for agent-to-agent chains).
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Visibility Preflight (can_access)</h3>
            <p className="text-sm text-zinc-600">
              Before an agent surfaces any entity into a shared surface, it must preflight the
              asker's ability to see it. can_access resolves a user + entity_type + entity_id
              pair to a structured allow/deny reason, reusing each app's existing visibility
              predicates so answers are consistent with what the list and detail endpoints
              would return.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Read Plane: Search, Resolve, Activity, Composite Views</h3>
            <p className="text-sm text-zinc-600">
              search_everything fans out across all seven searchable apps with normalized scoring
              and optional asker-mode filtering via can_access. resolve_references turns
              free-text mentions (plus the canonical [[TASK-123]], [[deal:Acme]], @jane,
              #project-slug syntax) into ranked entity candidates with confidence and
              disambiguation hints. activity_query and activity_by_actor read a unified view
              over Bam, Bond, and Helpdesk activity logs with correct actor_type mapping.
              account_view, project_view, and user_view compose parallel fan-outs across the
              suite with partial-failure semantics and a five-second per-arm timeout.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Write Plane: Upserts, Entity Links, Attachments</h3>
            <p className="text-sm text-zinc-600">
              Idempotent upserts land for bond_upsert_contact (by email), beacon_upsert_by_slug,
              helpdesk_upsert_user, and task_upsert_by_external_id. Each returns a created flag
              so callers can log create vs. update correctly, and each emits a *.upserted Bolt
              event. entity_links is a durable cross-app linking table backfilled from existing
              per-app FKs (tickets.task_id, bill_invoices.bond_deal_id, etc.) with three MCP
              tools for listing, creating, and removing links. Attachment metadata is exposed
              through a federated Bam-api dispatcher so attachment_get and attachment_list
              surface scan_status, mime, size, signature, and uploader across Bam, Helpdesk,
              Beacon, and Brief without reaching into MinIO directly.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Agent Policies and Outbound Webhooks</h3>
            <p className="text-sm text-zinc-600">
              agent_policies drives per-agent kill switches and tool allowlists. A register-tool
              wrapper in the MCP server fails closed on any service-account invocation when
              enabled=false or the tool is not in allowed_tools; a short-TTL cache with Redis
              PubSub invalidation makes policy flips propagate across MCP instances in seconds.
              Outbound webhook delivery pushes subscribed Bolt events to agent runners via
              HMAC-signed POSTs with a 0s/30s/2m/10m/30m/2h/6h/dead-letter backoff schedule,
              SSRF guards on the target URL, a 256KB payload cap, and a circuit breaker that
              auto-disables the webhook after 20 consecutive failures.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6">
            <h3 className="mb-3 text-lg font-semibold text-zinc-900">Long Tail: Dedupe, Trends, Expertise, Observability</h3>
            <p className="text-sm text-zinc-600">
              dedupe_decisions records "duplicate" / "not duplicate" / "needs review" verdicts
              in a canonical ordered-pair form so the same pair cannot be re-surfaced without
              consensus. bond_find_duplicates and helpdesk_find_similar_tickets return scored
              candidates with prior-decision annotations. helpdesk_ticket_count_by_phrase and
              bam_task_count_by_phrase bucket tsvector hits by hour/day/week over a bounded
              window. expertise_for_topic ranks people across Beacon ownership, Bam activity,
              Brief authorship, and Bond coverage with a configurable time-decay half-life.
              bolt_event_trace and bolt_recent_events explain why rules fired or skipped, and
              a runtime catalog.drift_detected event surfaces producer/catalog drift with 24h
              Redis-backed suppression.
            </p>
          </div>
        </div>
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
          as a multi-service Docker Compose stack (nineteen app APIs plus MCP server, worker, voice agent, frontends, and data services) behind a single nginx reverse proxy.
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
                <tr className="border-b border-zinc-100"><td className="py-2 pr-4 font-medium">mcp-server</td><td className="py-2 pr-4">3001</td><td className="py-2">MCP protocol server (804 tools)</td></tr>
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
          <div key={index} className="rounded-lg border border-zinc-200 bg-white">
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

type SectionId = 'mcp-tools' | 'api-endpoints' | 'user-guide' | 'deployment' | 'faqs';

interface SidebarSection {
  id: SectionId;
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
}

const sidebarSections: SidebarSection[] = [
  { id: 'mcp-tools', label: 'MCP Tools', sublabel: '804 tools', icon: <Zap className="h-4 w-4" /> },
  { id: 'api-endpoints', label: 'API Endpoints', icon: <Server className="h-4 w-4" /> },
  { id: 'user-guide', label: 'User Guide', icon: <Users className="h-4 w-4" /> },
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
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const hash = window.location.hash.replace('#', '');
    const validSections: SectionId[] = ['mcp-tools', 'api-endpoints', 'user-guide', 'deployment', 'faqs'];
    if (validSections.includes(hash as SectionId)) return hash as SectionId;
    return 'mcp-tools';
  });

  useEffect(() => {
    window.location.hash = activeSection;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [activeSection]);

  const renderContent = () => {
    switch (activeSection) {
      case 'mcp-tools':
        return <McpToolsContent />;
      case 'api-endpoints':
        return <ApiEndpointsContent />;
      case 'user-guide':
        return <UserGuideContent />;
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
