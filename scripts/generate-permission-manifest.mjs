#!/usr/bin/env node
//
// Permission manifest generator.
//
// Walks every MCP tool registration in apps/mcp-server/src/tools/ and every
// Fastify route declaration in apps/*/src/routes/, mapping each to a
// `<app>.<resource>.<verb>` permission identifier per the convention in
// docs/permissions-overhaul-plan.md.
//
// Output: docs/permissions-action-manifest.json — the canonical catalog
// committed to the repo and consumed by:
//   - infra/postgres/migrations/0142_permissions_seed_actions.sql (generated)
//   - packages/permissions/src/types.ts (generated)
//   - scripts/check-permission-catalog.mjs (CI drift guard)
//
// Edge cases (~16 tools that don't fit the <app>_<verb>_<resource> pattern):
// see EXPLICIT_OVERRIDES below. Anything else that fails the inference rules
// is written to docs/permissions-action-overrides.json with a TODO marker so
// a human can curate it before the seed migration runs.
//
// Re-run any time MCP tools or routes change. The CI guard is intentionally
// strict: an unmapped action fails the build.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/'), '..');
const MCP_TOOLS_DIR = join(ROOT, 'apps/mcp-server/src/tools');
const APPS_DIR = join(ROOT, 'apps');
const OUTPUT_PATH = join(ROOT, 'docs/permissions-action-manifest.json');

// ── Read verbs (resource verbs that map to permissions ending in *.list /
//    *.get / *.search / *.view / *.browse / *.query). Used to mark
//    permissions as "read" for the API-key scope ceiling and the auto-
//    generated Reader builtin group.
const READ_VERBS = new Set([
  'list', 'get', 'search', 'view', 'browse', 'query', 'read',
  'find', 'count', 'preview', 'export', 'summarize', 'detail',
  'graph', 'audit',
]);

// ── Destructive verbs that require operator confirmation (mirrors the MCP
//    confirm_action gating + UI "are you sure" dialogs). Used to populate
//    the `requires_confirmation` flag on the permission row.
const DESTRUCTIVE_VERBS = new Set([
  'delete', 'archive', 'remove', 'cancel', 'transfer',
  'destroy', 'purge', 'wipe',
]);

// ── Permissions that require SuperUser caller regardless of group
//    defaults. Mirrors migration 0152's UPDATE clauses. Editing this list
//    requires a follow-up delta migration that sets requires_superuser=true
//    for the added IDs.
const REQUIRES_SUPERUSER_IDS = new Set([
  'platform.org.create',
  'platform.org.delete',
  'platform.org.update',
  'platform.system.set_launchpad_defaults',
  'platform.system.set_public_signup_disabled',
  'platform.system.list_beta_signups',
  'platform.system.test_slack_webhook',
  'bam.context.switch',
]);

function computeRequiresSuperuser(id, resource) {
  if (REQUIRES_SUPERUSER_IDS.has(id)) return true;
  if (resource.startsWith('superuser_')) return true;
  return false;
}

// ── App prefixes — first segment of the permission ID. Tool names and
//    REST mount paths use these prefixes consistently. Anything else is
//    `platform.*` (cross-cutting) or `shared.*` (utility).
const APP_PREFIXES = new Set([
  'bam', 'banter', 'beacon', 'brief', 'bolt', 'bearing',
  'board', 'bond', 'blast', 'bench', 'book', 'blank', 'bill',
  'bin', 'bay', 'blip', 'helpdesk',
]);

// ── Tool name → permission ID overrides. Tools that don't fit the
//    `<app>_<verb>_<resource>` pattern, plus the always-permitted core.
const EXPLICIT_TOOL_OVERRIDES = new Map([
  // Always-permitted core tools (resolver step 2). Listed here so they
  // appear in the catalog with the right namespace; the resolver
  // short-circuits before per-action checks for these IDs.
  ['get_server_info', { id: 'platform.system.get_info', verb: 'get_info' }],
  ['get_me', { id: 'platform.user.get_profile', verb: 'get_profile' }],
  ['agent_heartbeat', { id: 'agent.self.heartbeat', verb: 'heartbeat' }],

  // System / utility tools that span apps.
  ['get_public_config', { id: 'platform.system.get_public_config', verb: 'get_public_config' }],
  ['get_platform_settings', { id: 'platform.system.get_platform_settings', verb: 'get_platform_settings' }],
  ['get_launchpad_apps', { id: 'platform.system.get_launchpad_apps', verb: 'get_launchpad_apps' }],
  ['set_org_launchpad_apps', { id: 'platform.org.set_launchpad_apps', verb: 'set_launchpad_apps' }],
  ['set_platform_launchpad_defaults', { id: 'platform.system.set_launchpad_defaults', verb: 'set_launchpad_defaults' }],
  ['set_public_signup_disabled', { id: 'platform.system.set_public_signup_disabled', verb: 'set_public_signup_disabled' }],
  ['confirm_action', { id: 'platform.system.confirm_action', verb: 'confirm_action' }],

  // Cross-app search + reference resolution.
  ['search_everything', { id: 'shared.system.search_global', verb: 'search_global' }],
  ['resolve_references', { id: 'shared.system.resolve_references', verb: 'resolve_references' }],

  // User self + identity actions.
  ['update_me', { id: 'platform.user.update_profile', verb: 'update_profile' }],
  ['change_my_password', { id: 'platform.user.change_password', verb: 'change_password' }],
  ['logout', { id: 'platform.user.logout', verb: 'logout' }],
  ['list_my_orgs', { id: 'platform.user.list_orgs', verb: 'list_orgs' }],
  ['list_my_notifications', { id: 'platform.user.list_notifications', verb: 'list_notifications' }],
  ['mark_notification_read', { id: 'platform.user.mark_notification_read', verb: 'mark_notification_read' }],
  ['mark_notifications_read', { id: 'platform.user.mark_notifications_read', verb: 'mark_notifications_read' }],
  ['mark_all_notifications_read', { id: 'platform.user.mark_all_notifications_read', verb: 'mark_all_notifications_read' }],
  ['switch_active_org', { id: 'platform.user.switch_org', verb: 'switch_org' }],
  ['get_my_tasks', { id: 'platform.user.get_my_tasks', verb: 'get_my_tasks' }],
  ['get_overdue_tasks', { id: 'platform.user.get_overdue_tasks', verb: 'get_overdue_tasks' }],
  ['can_access', { id: 'platform.visibility.can_access', verb: 'can_access' }],

  // User lookups (resolver tools).
  ['find_user_by_email', { id: 'platform.user.find_by_email', verb: 'find_by_email' }],
  ['find_user_by_name', { id: 'platform.user.find_by_name', verb: 'find_by_name' }],
  ['list_users', { id: 'platform.user.list', verb: 'list' }],
  ['list_members', { id: 'platform.org.list_members', verb: 'list_members' }],

  // Agent identity + audit + policy (the §15 surface).
  ['agent_audit', { id: 'agent.audit.read', verb: 'read' }],
  ['agent_self_report', { id: 'agent.self.report', verb: 'report' }],
  ['agent_policy_get', { id: 'agent.policy.get', verb: 'get' }],
  ['agent_policy_list', { id: 'agent.policy.list', verb: 'list' }],
  ['agent_policy_set', { id: 'agent.policy.set', verb: 'set' }],
  ['agent_webhook_configure', { id: 'agent.webhook.configure', verb: 'configure' }],
  ['agent_webhook_deliveries_list', { id: 'agent.webhook.list_deliveries', verb: 'list_deliveries' }],
  ['agent_webhook_redeliver', { id: 'agent.webhook.redeliver', verb: 'redeliver' }],
  ['agent_webhook_rotate_secret', { id: 'agent.webhook.rotate_secret', verb: 'rotate_secret' }],

  // Cross-cutting platform tools.
  ['platform_create_org', { id: 'platform.org.create', verb: 'create' }],
  ['platform_delete_org', { id: 'platform.org.delete', verb: 'delete' }],
  ['platform_get_org', { id: 'platform.org.get', verb: 'get' }],
  ['platform_list_orgs', { id: 'platform.org.list', verb: 'list' }],
  ['platform_update_org', { id: 'platform.org.update', verb: 'update' }],

  // Composite views (resource = composite).
  ['account_view', { id: 'bam.account.view', verb: 'view' }],
  ['project_view', { id: 'bam.project.view', verb: 'view' }],
  ['user_view', { id: 'platform.user.view', verb: 'view' }],

  // Activity + entity links.
  ['activity_query', { id: 'shared.activity.query', verb: 'query' }],
  ['activity_by_actor', { id: 'shared.activity.by_actor', verb: 'by_actor' }],
  ['entity_link_create', { id: 'shared.entity_link.create', verb: 'create' }],
  ['entity_link_remove', { id: 'shared.entity_link.remove', verb: 'remove' }],
  ['entity_links_list', { id: 'shared.entity_link.list', verb: 'list' }],
  ['attachment_get', { id: 'shared.attachment.get', verb: 'get' }],
  ['attachment_list', { id: 'shared.attachment.list', verb: 'list' }],

  // Dedupe + phrase counts + expertise + ingest fingerprint.
  ['dedupe_list_pending', { id: 'shared.dedupe.list_pending', verb: 'list_pending' }],
  ['dedupe_record_decision', { id: 'shared.dedupe.record_decision', verb: 'record_decision' }],
  ['expertise_for_topic', { id: 'shared.expertise.for_topic', verb: 'for_topic' }],
  ['ingest_fingerprint_check', { id: 'shared.ingest.fingerprint_check', verb: 'fingerprint_check' }],

  // Bam core (named without bam_ prefix in the tool layer).
  ['create_task', { id: 'bam.task.create', verb: 'create' }],
  ['get_task', { id: 'bam.task.get', verb: 'get' }],
  ['update_task', { id: 'bam.task.update', verb: 'update' }],
  ['delete_task', { id: 'bam.task.delete', verb: 'delete' }],
  ['duplicate_task', { id: 'bam.task.duplicate', verb: 'duplicate' }],
  ['move_task', { id: 'bam.task.move', verb: 'move' }],
  ['search_tasks', { id: 'bam.task.search', verb: 'search' }],
  ['bulk_update_tasks', { id: 'bam.task.bulk_update', verb: 'bulk_update' }],
  ['log_time', { id: 'bam.task.log_time', verb: 'log_time' }],
  ['add_comment', { id: 'bam.comment.create', verb: 'create' }],
  ['list_comments', { id: 'bam.comment.list', verb: 'list' }],
  ['create_project', { id: 'bam.project.create', verb: 'create' }],
  ['get_project', { id: 'bam.project.get', verb: 'get' }],
  ['list_projects', { id: 'bam.project.list', verb: 'list' }],
  ['create_sprint', { id: 'bam.sprint.create', verb: 'create' }],
  ['list_sprints', { id: 'bam.sprint.list', verb: 'list' }],
  ['start_sprint', { id: 'bam.sprint.start', verb: 'start' }],
  ['complete_sprint', { id: 'bam.sprint.complete', verb: 'complete' }],
  ['get_sprint_report', { id: 'bam.sprint.report', verb: 'report' }],
  ['get_burndown', { id: 'bam.report.burndown', verb: 'burndown' }],
  ['get_velocity_report', { id: 'bam.report.velocity', verb: 'velocity' }],
  ['get_cycle_time_report', { id: 'bam.report.cycle_time', verb: 'cycle_time' }],
  ['get_workload', { id: 'bam.report.workload', verb: 'workload' }],
  ['get_status_distribution', { id: 'bam.report.status_distribution', verb: 'status_distribution' }],
  ['get_cumulative_flow', { id: 'bam.report.cumulative_flow', verb: 'cumulative_flow' }],
  ['get_time_tracking_report', { id: 'bam.report.time_tracking', verb: 'time_tracking' }],
  ['list_templates', { id: 'bam.template.list', verb: 'list' }],
  ['create_from_template', { id: 'bam.template.create_from', verb: 'create_from' }],
  ['list_tickets', { id: 'helpdesk.ticket.list', verb: 'list' }],
  ['get_ticket', { id: 'helpdesk.ticket.get', verb: 'get' }],
  ['reply_to_ticket', { id: 'helpdesk.ticket.reply', verb: 'reply' }],
  ['update_ticket_status', { id: 'helpdesk.ticket.update_status', verb: 'update_status' }],
  ['import_csv', { id: 'bam.import.csv', verb: 'csv' }],
  ['import_github_issues', { id: 'bam.import.github_issues', verb: 'github_issues' }],
  ['disconnect_github_integration', { id: 'bam.integration.disconnect_github', verb: 'disconnect_github' }],
  ['suggest_branch_name', { id: 'bam.task.suggest_branch_name', verb: 'suggest_branch_name' }],
  ['list_beta_signups', { id: 'platform.system.list_beta_signups', verb: 'list_beta_signups' }],
  ['submit_beta_signup', { id: 'platform.system.submit_beta_signup', verb: 'submit_beta_signup' }],
  ['test_slack_webhook', { id: 'platform.system.test_slack_webhook', verb: 'test_slack_webhook' }],
  ['proposal_create', { id: 'platform.proposal.create', verb: 'create' }],
  ['proposal_list', { id: 'platform.proposal.list', verb: 'list' }],
  ['proposal_decide', { id: 'platform.proposal.decide', verb: 'decide' }],
  ['task_upsert_by_external_id', { id: 'bam.task.upsert_by_external_id', verb: 'upsert_by_external_id' }],

  // Bin tools are resource-first (bin_asset_create, bin_data_read) rather than
  // the verb-first inference convention, so map each to the same permission id
  // its REST endpoint already uses (the tool and endpoint share the permission).
  ['bin_asset_list', { id: 'bin.asset.list', verb: 'list' }],
  ['bin_asset_get', { id: 'bin.asset.get', verb: 'get' }],
  ['bin_asset_create', { id: 'bin.asset.create', verb: 'create' }],
  ['bin_asset_archive', { id: 'bin.asset.archive', verb: 'archive' }],
  ['bin_asset_delete', { id: 'bin.asset.delete', verb: 'delete' }],
  ['bin_version_list', { id: 'bin.version.get', verb: 'get' }],
  ['bin_folder_list', { id: 'bin.folder.list', verb: 'list' }],
  ['bin_folder_create', { id: 'bin.folder.create', verb: 'create' }],
  ['bin_data_read', { id: 'bin.data.get', verb: 'get' }],
  ['bin_data_open_session', { id: 'bin.data_session.create', verb: 'create' }],
  ['bin_data_append_rows', { id: 'bin.data_row.create', verb: 'create' }],
  ['bin_data_patch', { id: 'bin.data_row.update', verb: 'update' }],
  ['bin_data_patch_tree', { id: 'bin.data_tree.update', verb: 'update' }],
  ['bin_data_comment_list', { id: 'bin.data_comment.get', verb: 'get' }],
  ['bin_data_comment_create', { id: 'bin.data_comment.create', verb: 'create' }],
  ['bin_data_comment_resolve', { id: 'bin.data_comment_resolve.create', verb: 'create' }],
  ['bin_data_array_op', { id: 'bin.data_array.create', verb: 'create' }],
  ['bin_asset_update', { id: 'bin.asset.update', verb: 'update' }],
  ['bin_tag_list', { id: 'bin.tag.list', verb: 'list' }],

  // Bay tools (resource-first names) → the same permission ids their REST
  // endpoints use (review layer on top of Bin).
  ['bay_asset_list', { id: 'bay.asset.list', verb: 'list' }],
  ['bay_asset_get', { id: 'bay.asset.get', verb: 'get' }],
  ['bay_asset_create', { id: 'bay.asset.create', verb: 'create' }],
  ['bay_asset_archive', { id: 'bay.asset.archive', verb: 'archive' }],
  ['bay_version_list', { id: 'bay.asset_version.get', verb: 'get' }],
  ['bay_version_get', { id: 'bay.version.get', verb: 'get' }],
  ['bay_version_create', { id: 'bay.asset_version.create', verb: 'create' }],
  ['bay_annotation_list', { id: 'bay.version_annotation.get', verb: 'get' }],
  ['bay_annotation_create', { id: 'bay.version_annotation.create', verb: 'create' }],
  ['bay_annotation_resolve', { id: 'bay.annotation_resolve.create', verb: 'create' }],
  ['bay_decision_list', { id: 'bay.version_decision.get', verb: 'get' }],
  ['bay_decision_set', { id: 'bay.version_decision.update', verb: 'update' }],
  ['bay_review_resolve', { id: 'bay.review_resolve.create', verb: 'create' }],
  ['bay_review_link_create', { id: 'bay.review_link.create', verb: 'create' }],

  // Blip tools (verb-second names like blip_app_create, blip_field_set_metric)
  // → the canonical `<app>.<resource>.<verb>` ids from the Blip design doc §16,
  //   which are exactly the ids the blip-api routes enforce via requireCan().
  //   blip-api is intentionally NOT in APP_TO_PREFIX, so these tool overrides
  //   are the sole source of the blip.* catalog rows; every requireCan id must
  //   appear here. Reads collapse onto the *.read ids and carry a read verb so
  //   is_read classification is order-independent.
  ['blip_app_create', { id: 'blip.app.create', verb: 'create' }],
  ['blip_app_get', { id: 'blip.app.read', verb: 'get' }],
  ['blip_app_list', { id: 'blip.app.read', verb: 'list' }],
  ['blip_app_update', { id: 'blip.app.update', verb: 'update' }],
  ['blip_app_delete', { id: 'blip.app.delete', verb: 'delete' }],
  ['blip_report_types_list', { id: 'blip.app.read', verb: 'list' }],
  ['blip_field_catalog_list', { id: 'blip.app.read', verb: 'list' }],
  ['blip_collection_set', { id: 'blip.collection.toggle', verb: 'toggle' }],
  ['blip_key_create', { id: 'blip.key.create', verb: 'create' }],
  ['blip_key_list', { id: 'blip.key.list', verb: 'list' }],
  ['blip_key_suspend', { id: 'blip.key.suspend', verb: 'suspend' }],
  ['blip_key_revoke', { id: 'blip.key.revoke', verb: 'revoke' }],
  ['blip_key_update', { id: 'blip.key.update', verb: 'update' }],
  ['blip_ratelimit_set', { id: 'blip.ratelimit.manage', verb: 'manage' }],
  ['blip_retention_set', { id: 'blip.retention.manage', verb: 'manage' }],
  ['blip_transform_set', { id: 'blip.transform.manage', verb: 'manage' }],
  ['blip_field_index', { id: 'blip.field.index', verb: 'index' }],
  ['blip_field_set_metric', { id: 'blip.field.metric', verb: 'metric' }],
  ['blip_entry_query', { id: 'blip.entry.read', verb: 'query' }],
  ['blip_entry_tail', { id: 'blip.entry.read', verb: 'read' }],
  ['blip_entry_purge', { id: 'blip.entry.purge', verb: 'purge' }],
  ['blip_entry_export', { id: 'blip.entry.export', verb: 'export' }],
  ['blip_view_create', { id: 'blip.view.create', verb: 'create' }],
  ['blip_view_update', { id: 'blip.view.update', verb: 'update' }],
  ['blip_view_delete', { id: 'blip.view.delete', verb: 'delete' }],
  ['blip_view_list', { id: 'blip.view.read', verb: 'list' }],
  ['blip_watch_create', { id: 'blip.watch.create', verb: 'create' }],
  ['blip_watch_get', { id: 'blip.watch.read', verb: 'get' }],
  ['blip_watch_list', { id: 'blip.watch.read', verb: 'list' }],
  ['blip_watch_history', { id: 'blip.watch.read', verb: 'read' }],
  ['blip_watch_update', { id: 'blip.watch.update', verb: 'update' }],
  ['blip_watch_delete', { id: 'blip.watch.delete', verb: 'delete' }],
  ['blip_watch_set_enabled', { id: 'blip.watch.enable', verb: 'enable' }],
  ['blip_watch_test', { id: 'blip.watch.test', verb: 'test' }],
  ['blip_capture_url', { id: 'blip.timelapse.read', verb: 'get' }],
  ['blip_timelapse_create', { id: 'blip.timelapse.create', verb: 'create' }],
  ['blip_timelapse_get', { id: 'blip.timelapse.read', verb: 'get' }],
  ['blip_timelapse_list', { id: 'blip.timelapse.read', verb: 'list' }],
]);

// ── Inference helpers ──────────────────────────────────────────────────

function detectAppPrefix(toolName) {
  const m = toolName.match(/^([a-z]+)_/);
  if (m && APP_PREFIXES.has(m[1])) return m[1];
  // Beacon's `helpdesk_*` tools come from the helpdesk-tools.ts file but
  // serve the helpdesk app surface; the prefix is the first segment.
  return null;
}

function inferToolPermissionId(toolName) {
  if (EXPLICIT_TOOL_OVERRIDES.has(toolName)) {
    return EXPLICIT_TOOL_OVERRIDES.get(toolName);
  }

  const app = detectAppPrefix(toolName);
  if (!app) return null;

  // Strip the app prefix; what remains is `<verb>_<resource>` or
  // `<verb>_<resource>_<modifier>` etc. The convention is verb-first.
  const rest = toolName.slice(app.length + 1);
  const segments = rest.split('_');
  if (segments.length === 0) return null;

  // Collapse the verb. Most tools start with one of a small known set.
  const KNOWN_VERBS = [
    'create', 'get', 'list', 'update', 'delete', 'search', 'find',
    'add', 'remove', 'archive', 'send', 'finalize', 'pin', 'unpin',
    'react', 'reply', 'edit', 'invite', 'join', 'leave', 'set',
    'rotate', 'configure', 'test', 'browse', 'count', 'detect',
    'compare', 'generate', 'summarize', 'preview', 'subscribe',
    'unsubscribe', 'share', 'schedule', 'merge', 'move', 'close',
    'score', 'log', 'upsert', 'record', 'request', 'approve',
    'reject', 'check', 'unsubscribed', 'draft', 'export', 'publish',
    'view', 'restore', 'verify', 'duplicate', 'append', 'link',
    'promote', 'redeliver', 'heartbeat', 'audit', 'self', 'webhook',
    'policy',
  ];

  let verb = null;
  let resource = null;

  // Greedy: take longest prefix that's a known verb or known verb pair.
  for (const v of KNOWN_VERBS) {
    if (rest === v) {
      verb = v;
      resource = 'self';
      break;
    }
    if (rest.startsWith(v + '_')) {
      verb = v;
      resource = rest.slice(v.length + 1);
      break;
    }
  }

  if (!verb) {
    // Last resort: take the first segment as the verb.
    verb = segments[0];
    resource = segments.slice(1).join('_') || 'self';
  }

  return { id: `${app}.${resource}.${verb}`, verb };
}

// ── MCP tool extraction ────────────────────────────────────────────────

function extractMcpTools() {
  const tools = [];
  const files = readdirSync(MCP_TOOLS_DIR).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const path = join(MCP_TOOLS_DIR, file);
    const text = readFileSync(path, 'utf8');
    // Match registerTool(server, { ... name: 'foo', description: 'bar', ...
    // We use a non-greedy match and pull the literal 'name' value.
    const regex = /registerTool\s*\(\s*server\s*,\s*\{[\s\S]*?name:\s*['"]([a-zA-Z0-9_]+)['"]/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const toolName = m[1];
      const inferred = inferToolPermissionId(toolName);
      tools.push({
        source: 'mcp',
        tool_name: toolName,
        file: file,
        inferred,
      });
    }
  }
  return tools;
}

// ── REST route extraction ──────────────────────────────────────────────

const APP_TO_PREFIX = {
  api: 'bam',
  'banter-api': 'banter',
  'beacon-api': 'beacon',
  'brief-api': 'brief',
  'bolt-api': 'bolt',
  'bearing-api': 'bearing',
  'board-api': 'board',
  'bond-api': 'bond',
  'blast-api': 'blast',
  'bench-api': 'bench',
  'book-api': 'book',
  'blank-api': 'blank',
  'bill-api': 'bill',
  'bin-api': 'bin',
  'bay-api': 'bay',
  'helpdesk-api': 'helpdesk',
};

function methodVerb(method, path, hasIdParam) {
  // Map (method, path) -> verb. Path-suffix overrides win for action routes.
  const m = path.match(/\/([a-z_]+)\/?$/);
  const lastSegment = m && m[1];
  const ACTION_SEGMENTS = new Set([
    'archive', 'unarchive', 'send', 'finalize', 'cancel', 'restore',
    'move', 'duplicate', 'reply', 'react', 'pin', 'unpin', 'invite',
    'join', 'leave', 'close', 'reopen', 'submit', 'approve', 'reject',
    'publish', 'unpublish', 'rotate', 'verify', 'export', 'import',
    'merge', 'split', 'lock', 'unlock', 'mute', 'unmute', 'follow',
    'unfollow', 'subscribe', 'unsubscribe', 'redeliver', 'heartbeat',
    'switch', 'transfer', 'promote', 'demote',
  ]);
  if (lastSegment && ACTION_SEGMENTS.has(lastSegment) &&
      (method === 'post' || method === 'patch' || method === 'put')) {
    return lastSegment;
  }

  if (method === 'get') return hasIdParam ? 'get' : 'list';
  if (method === 'post') return 'create';
  if (method === 'patch' || method === 'put') return 'update';
  if (method === 'delete') return 'delete';
  return method;
}

function inferResourceFromPath(path, app) {
  // Strip leading slash, params, and trailing action segments to get the
  // resource. /v1/channels/:id/messages -> channels.messages
  // /tasks/:id/move -> tasks (with verb=move)
  let segments = path.split('/').filter(Boolean);
  // Strip file extensions from the last segment (calendar.ics -> calendar).
  if (segments.length > 0) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.[a-z]+$/i, '');
  }
  // Drop API version prefixes.
  if (segments[0] && /^v\d+$/.test(segments[0])) segments = segments.slice(1);
  // Drop the app prefix if it leaks into the path (e.g. /helpdesk/users on
  // helpdesk-api).
  if (segments[0] === app) segments = segments.slice(1);

  const ACTION_SEGMENTS = new Set([
    'archive', 'unarchive', 'send', 'finalize', 'cancel', 'restore',
    'move', 'duplicate', 'reply', 'react', 'pin', 'unpin', 'invite',
    'join', 'leave', 'close', 'reopen', 'submit', 'approve', 'reject',
    'publish', 'unpublish', 'rotate', 'verify', 'export', 'import',
    'merge', 'split', 'lock', 'unlock', 'mute', 'unmute', 'follow',
    'unfollow', 'subscribe', 'unsubscribe', 'redeliver', 'heartbeat',
    'switch', 'transfer', 'promote', 'demote',
  ]);
  // Drop trailing action segment (handled by verb).
  if (segments.length > 0 && ACTION_SEGMENTS.has(segments[segments.length - 1])) {
    segments.pop();
  }
  // Drop trailing params and wildcards.
  while (segments.length > 0 && (segments[segments.length - 1].startsWith(':') || segments[segments.length - 1].includes('*'))) {
    segments.pop();
  }
  // Build resource. Multiple non-param segments compose with underscores
  // (NOT dots) so the permission ID stays at exactly three segments
  // app.resource.verb — nested resources like /channels/:id/members
  // become `channel_member`, not `channel.member`. The schema's
  // permissions(app, resource, verb) columns would otherwise be ambiguous.
  // Wildcards (e.g. `/files/*` for file-download) are skipped along with
  // :id params; the resource becomes the parent segment ('file').
  const nonParam = segments.filter((s) => !s.startsWith(':') && !s.includes('*'));
  if (nonParam.length === 0) return 'self';
  // Singularize each segment if it ends in 's' (very rough; avoids
  // 'agent_policies' -> 'agent_policie' artifact by special-casing 'ies').
  function singularize(s) {
    if (s.endsWith('ies') && s.length > 3) return s.slice(0, -3) + 'y';
    // 'es' is the correct plural suffix only after sibilant clusters
    // (-s, -x, -ch, -sh). Naive 'ses -> s' wrecks normal -e words: it
    // turned 'expenses' into 'expens' and 'phases' into 'phas' for Wave
    // A's catalog. Restrict the rule to actual sibilant plurals.
    if (/(?:ss|x|ch|sh|z)es$/.test(s)) return s.slice(0, -2);
    if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
    return s;
  }
  return nonParam.map((s) => singularize(s).replace(/-/g, '_')).join('_');
}

// Path prefixes excluded from the catalog. /internal/* routes are
// shared-secret authenticated (not session/api-key) and don't go through
// the permissions resolver — gating them would conflict with the
// inter-service trust model. Health/version probes are similarly
// public surface that doesn't fit the resolver's mental model.
//
// Phase 1 of the Wave D rollout added the rest of this list: login/
// oauth/webhook/ical/files endpoints that are intentionally unauthenticated
// or whose authentication channel isn't the session/api-key resolver.
// Decisions live in docs/wave-d-audit/phase1-triage.json.
const EXCLUDED_PATH_PREFIXES = [
  '/internal/',
  '/health',
  '/healthz',
  '/readyz',
  '/version',
  // Wave D Phase 1 additions: public / non-action routes.
  // Note: /auth/ and /files/ were considered for this list but excluded —
  // /auth/api-keys and /auth/service-accounts are real authenticated
  // user actions, and /files/* is the authenticated download proxy. The
  // public-auth file basenames are handled via EXCLUDED_FILE_BASENAMES.
  '/public/',
  '/webhooks/github',
  '/webhooks/slack',
  '/me/calendar.ics',
  '/projects/:id/calendar.ics',
  '/root-redirect',
  '/v1/agents/heartbeat',
  '/v1/guests/accept/',
  // Bin scan surfaces. bulk-delete is gated by the shared destructive
  // bin.asset.delete permission (the DELETE /assets/:id route already mints
  // it); scan-override is gated in-handler to org owner/admin/SuperUser.
  // Path-derived ids here would be non-destructive-shaped duplicates
  // (…_bulk_delete.create / …_scan_override.create), so exclude them.
  '/assets/bulk-delete',
  '/assets/:id/scan-override',
  // Member email change is deliberately gated by the shared
  // bam.org_member_profile.update permission (it is a profile-management
  // action that admins/owners already hold), not a distinct path-derived
  // org_member_email.update. Exclude so the generator doesn't mint an
  // unused duplicate action. Same rationale as /assets/bulk-delete above.
  '/org/members/:userId/email',
];

// File basenames whose every route is non-action (unauthenticated, internal-
// service-secret, or webhook receiver). Added in Wave D Phase 1 after the
// triage in docs/wave-d-audit/phase1-triage.json found that mount-prefix
// resolution would be needed to catch these via path prefixes alone (the
// internal-helpdesk routes declare 'POST /tasks' and rely on the server.ts
// '/internal/helpdesk' mount prefix). File-level exclusion is the simple
// fix; teaching the generator to compose mount prefixes is the long-term
// fix tracked as a follow-up.
const EXCLUDED_FILE_BASENAMES = new Set([
  'auth.routes.ts',
  'oauth.routes.ts',
  'email-verify.routes.ts',
  'public-config.routes.ts',
  'github-webhook.routes.ts',
  'slack-webhook.routes.ts',
  'internal-helpdesk.routes.ts',
  'internal-llm.routes.ts',
  'ical.routes.ts',
  // Wave F: permissions-admin routes use contract-document ids
  // (e.g. bam.superuser_permission_group.set_defaults) rather than
  // path-derived ids (bam.superuser_permission_group_default.update).
  // The hand-curated ids are authored by migration 0160 and exposed
  // via requireCan() at the route's preHandler. Auto-deriving from
  // the route path would create duplicates with different shapes.
  'permissions-admin.routes.ts',
  // Wave B: permissions-divergences uses bam.superuser_permission_divergence.list
  // which the generator already correctly derives from the path; including
  // here as belt-and-suspenders so the audit doesn't churn the manifest.
  'permissions-divergences.routes.ts',
  // Bin scan routes: GET /scan/overview is authenticated scan-progress data
  // and PUT /scan/policy is gated in-handler to org owner/admin/SuperUser.
  // Neither maps to an asset resource.verb, so exclude from path derivation.
  'scan.routes.ts',
  // Deploy-settings backend: routes use the hand-authored ids
  // bam.superuser_deploy_settings.{get,update,verify}. The path-derived
  // auto-ids would singularize 'settings' to 'setting' and would not
  // capture the verify-repo verb cleanly.
  'deploy-settings.routes.ts',
  // Slack-import (banter-api): routes use the hand-authored ids
  // banter.admin_import.{create,status,abort}. The path-derived auto-ids
  // would explode into per-endpoint perms like
  // banter.admin_import_slack_upload.create and would singularize
  // 'status' to 'statu'. Three real catalog rows are seeded by 0168;
  // routes call fastify.requireCan() against those ids directly.
  'slack-import.routes.ts',
  // WebSocket upgrade routes (realtime channels) are not authz actions and
  // are gated by their own preHandler, not requireCan(). The path-derived
  // auto-id also mangles `GET /ws` into `<app>.w.list` (singularize ws -> w).
  // Every app's realtime route lives in a `ws.routes.ts`.
  'ws.routes.ts',
]);

function isPathExcluded(routePath) {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => {
    // Normalize: '/internal/' covers '/internal/...' AND '/internal'
    const trimmed = prefix.replace(/\/$/, '');
    return routePath === trimmed || routePath.startsWith(trimmed + '/');
  });
}

function isFileExcluded(fileBasename) {
  return EXCLUDED_FILE_BASENAMES.has(fileBasename);
}

function extractRestRoutes() {
  const routes = [];
  const apps = Object.keys(APP_TO_PREFIX);
  for (const app of apps) {
    const dir = join(APPS_DIR, app, 'src/routes');
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const entry of readdirSync(cur)) {
        const path = join(cur, entry);
        const stats = statSync(path);
        if (stats.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (!entry.endsWith('.ts') && !entry.endsWith('.routes.ts')) continue;
        if (isFileExcluded(entry)) continue;
        const text = readFileSync(path, 'utf8');
        // fastify.get('/path', { ... }, handler)
        // fastify.post<{...}>('/path/:id', ...)
        // Multi-line type args are common, so the lookahead spans 15
        // lines (a real-world max in apps/api is ~8 lines of generics
        // followed by the path string).
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const mm = line.match(/fastify\.(get|post|put|patch|delete)/);
          if (!mm) continue;
          const block = lines.slice(i, i + 15).join('\n');
          // After the verb, allow balanced <...> type args, then ( then
          // the first string literal (the path).
          const pathMatch = block.match(/fastify\.(?:get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*['"`]([^'"`]+)['"`]/);
          if (!pathMatch) continue;
          const method = mm[1];
          const routePath = pathMatch[1];
          if (isPathExcluded(routePath)) continue;
          const prefix = APP_TO_PREFIX[app];
          const hasIdParam = routePath.includes('/:');
          const verb = methodVerb(method, routePath, hasIdParam);
          const resource = inferResourceFromPath(routePath, prefix);
          const id = `${prefix}.${resource}.${verb}`;
          routes.push({
            source: 'rest',
            method: method.toUpperCase(),
            path: routePath,
            app,
            file: basename(path),
            inferred: { id, verb },
          });
        }
      }
    }
  }
  return routes;
}

// ── Build manifest ─────────────────────────────────────────────────────

function buildManifest() {
  const tools = extractMcpTools();
  const routes = extractRestRoutes();

  // Collapse to unique permission IDs. Multiple tools/routes can map to
  // the same permission (e.g. both a list MCP tool and a GET REST route).
  // We track the first sighting + count of occurrences for each.
  const byId = new Map();

  function record(entry) {
    if (!entry.inferred || !entry.inferred.id) return;
    const id = entry.inferred.id;
    if (!byId.has(id)) {
      const [app, resource, verb] = id.split('.', 3);
      byId.set(id, {
        id,
        app,
        resource,
        verb,
        is_destructive: DESTRUCTIVE_VERBS.has(entry.inferred.verb),
        is_read: READ_VERBS.has(entry.inferred.verb),
        requires_confirmation: DESTRUCTIVE_VERBS.has(entry.inferred.verb),
        requires_superuser: computeRequiresSuperuser(id, resource),
        sources: [],
      });
    }
    const row = byId.get(id);
    row.sources.push({
      source: entry.source,
      ref: entry.tool_name || `${entry.method} ${entry.path}`,
      file: entry.file,
    });
  }

  for (const t of tools) record(t);
  for (const r of routes) record(r);

  // Add the always-permitted core trio explicitly even if they didn't
  // come through the tool scan (they might be wrapped differently).
  const ALWAYS_PERMITTED = [
    { id: 'platform.system.get_info', app: 'platform', resource: 'system', verb: 'get_info' },
    { id: 'platform.user.get_profile', app: 'platform', resource: 'user', verb: 'get_profile' },
    { id: 'agent.self.heartbeat', app: 'agent', resource: 'self', verb: 'heartbeat' },
  ];
  for (const c of ALWAYS_PERMITTED) {
    if (!byId.has(c.id)) {
      byId.set(c.id, {
        ...c,
        is_destructive: false,
        is_read: true,
        requires_confirmation: false,
        requires_superuser: false,
        sources: [{ source: 'core', ref: 'always_permitted', file: 'register-tool.ts' }],
      });
    } else {
      // Mark as core in metadata.
      byId.get(c.id).is_core = true;
    }
  }

  // Wave F + Wave B: hand-curated admin permissions for the SU permissions
  // editor and divergence dashboard. The route files that consume them are
  // in EXCLUDED_FILE_BASENAMES because the auto-deriver would mangle the
  // ids (e.g. /groups/:id/defaults → bam.superuser_permission_group_default.update
  // instead of bam.superuser_permission_group.set_defaults). Keep these
  // in sync with migration 0160 (and 0146 for divergence rows).
  const HAND_AUTHORED = [
    // Wave B — divergence dashboard (migration 0146-era)
    { id: 'bam.superuser_permission_divergence.list', resource: 'superuser_permission_divergence', verb: 'list', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_divergence_summary.list', resource: 'superuser_permission_divergence_summary', verb: 'list', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    // Wave F — admin surface (migration 0160)
    { id: 'bam.superuser_permission_catalog.list', resource: 'superuser_permission_catalog', verb: 'list', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.list', resource: 'superuser_permission_group', verb: 'list', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.create', resource: 'superuser_permission_group', verb: 'create', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.get', resource: 'superuser_permission_group', verb: 'get', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.update', resource: 'superuser_permission_group', verb: 'update', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.delete', resource: 'superuser_permission_group', verb: 'delete', is_read: false, is_destructive: true, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.set_defaults', resource: 'superuser_permission_group', verb: 'set_defaults', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_group.reset', resource: 'superuser_permission_group', verb: 'reset', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_user.get', resource: 'superuser_permission_user', verb: 'get', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_user.set_membership', resource: 'superuser_permission_user', verb: 'set_membership', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_user.set_override', resource: 'superuser_permission_user', verb: 'set_override', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_user.clear_override', resource: 'superuser_permission_user', verb: 'clear_override', is_read: false, is_destructive: true, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_permission_user.reattach', resource: 'superuser_permission_user', verb: 'reattach', is_read: false, is_destructive: true, requires_confirmation: false, requires_superuser: true },
    // Deploy-settings backend (companion to the SU permissions editor — read/
    // write the deploy_branch / deploy_repo_url / deploy_github_token /
    // deploy_auto_update_enabled keys in system_settings, plus a GitHub-
    // repo verifier). Routes live in apps/api/src/routes/deploy-settings.routes.ts;
    // ids are hand-authored because the path-derived auto-id would be
    // bam.superuser_deploy_setting.{get,update} (singular, drops the
    // verify-repo verb entirely).
    { id: 'bam.superuser_deploy_settings.get', resource: 'superuser_deploy_settings', verb: 'get', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_deploy_settings.update', resource: 'superuser_deploy_settings', verb: 'update', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    { id: 'bam.superuser_deploy_settings.verify', resource: 'superuser_deploy_settings', verb: 'verify', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: true },
    // Slack-import (docs/plans/slack-import-design.md §6). Three admin-level
    // permissions for the operator-facing Slack workspace import flow exposed
    // at /banter/api/v1/admin/import/slack/*. Hand-authored because the
    // route file does not exist yet in this wave (Agent B's scope) — the
    // catalog rows need to land first so Agent B can call requireCan() with
    // a valid id. Not requires_superuser=true: org admin/owner-level gate
    // delivered via the built-in group defaults logic.
    { id: 'banter.admin_import.create', app: 'banter', resource: 'admin_import', verb: 'create', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'banter.admin_import.status', app: 'banter', resource: 'admin_import', verb: 'status', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'banter.admin_import.abort', app: 'banter', resource: 'admin_import', verb: 'abort', is_read: false, is_destructive: true, requires_confirmation: false, requires_superuser: false },
    // Basis (migration 0229_permissions_seed_actions_delta_020). basis-api is a
    // satellite app deliberately NOT in APP_TO_PREFIX, and its MCP tools use a
    // `basis_` prefix that is not in APP_PREFIXES, so neither the route scanner
    // nor the tool scanner emits these ids. They are hand-authored for two
    // reasons: (1) custom verbs (define/certify/decertify/deprecate/version) are
    // not derivable from HTTP method, and (2) certify/decertify are a truth-flip
    // that requires_confirmation WITHOUT being is_destructive - a shape the
    // verb-driven classifier cannot produce (it ties the two flags together).
    // `metric.update` (PATCH /metrics/:id) and `datasource.read` (GET
    // /v1/data-sources) are no-tool endpoints per the design doc. Keep this list
    // in sync with the basis rows in migration 0229.
    { id: 'basis.metric.read', app: 'basis', resource: 'metric', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'basis.metric.define', app: 'basis', resource: 'metric', verb: 'define', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'basis.metric.update', app: 'basis', resource: 'metric', verb: 'update', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'basis.metric.version', app: 'basis', resource: 'metric', verb: 'version', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'basis.metric.certify', app: 'basis', resource: 'metric', verb: 'certify', is_read: false, is_destructive: false, requires_confirmation: true, requires_superuser: false },
    { id: 'basis.metric.decertify', app: 'basis', resource: 'metric', verb: 'decertify', is_read: false, is_destructive: false, requires_confirmation: true, requires_superuser: false },
    { id: 'basis.metric.deprecate', app: 'basis', resource: 'metric', verb: 'deprecate', is_read: false, is_destructive: true, requires_confirmation: true, requires_superuser: false },
    { id: 'basis.explain.run', app: 'basis', resource: 'explain', verb: 'run', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'basis.datasource.read', app: 'basis', resource: 'datasource', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    // Braid (identity-resolution CDP). Like basis, braid-api is a satellite NOT in
    // APP_PREFIXES and its braid_ MCP tools are deliberately kept out of
    // EXPLICIT_TOOL_OVERRIDES (satellite deferral, spec 2.6/BP3-1), so neither the
    // route nor the tool scanner emits these ids. Hand-authored with EXPLICIT is_read on
    // every row so no flag depends on verb inference: resolve is is_read:false because
    // POST /v1/resolve can lazily mint a singleton (must not be reachable under a
    // read-only key scope ceiling); merge/split are the truth-flips (is_destructive +
    // requires_confirmation). Keep in sync with the braid rows in the delta migration.
    { id: 'braid.profile.read', app: 'braid', resource: 'profile', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'braid.profile.resolve', app: 'braid', resource: 'profile', verb: 'resolve', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'braid.profile.merge', app: 'braid', resource: 'profile', verb: 'merge', is_read: false, is_destructive: true, requires_confirmation: true, requires_superuser: false },
    { id: 'braid.profile.split', app: 'braid', resource: 'profile', verb: 'split', is_read: false, is_destructive: true, requires_confirmation: true, requires_superuser: false },
    { id: 'braid.candidate.read', app: 'braid', resource: 'candidate', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'braid.rule.read', app: 'braid', resource: 'rule', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'braid.rule.write', app: 'braid', resource: 'rule', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'braid.settings.read', app: 'braid', resource: 'settings', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'braid.settings.write', app: 'braid', resource: 'settings', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    // Bulwark (contract-obligation / compliance app, spec Section 10 lines 679-692).
    // Like basis and braid, bulwark-api is a satellite NOT in APP_TO_PREFIX and its
    // bulwark_ MCP tools are deliberately kept out of EXPLICIT_TOOL_OVERRIDES (satellite
    // deferral), so neither the route nor the tool scanner emits these ids. Hand-authored
    // with EXPLICIT is_read on every row. Only contract.delete is manifest-destructive
    // (is_destructive + requires_confirmation); the reject/waive confirm boundaries live at
    // the MCP tool layer, NOT on the manifest rows, so obligation.write / deadline.write
    // stay is_read:false WITHOUT manifest-level confirm. Keep in sync with the bulwark rows
    // in the delta migration.
    { id: 'bulwark.contract.read', app: 'bulwark', resource: 'contract', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.contract.write', app: 'bulwark', resource: 'contract', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.contract.delete', app: 'bulwark', resource: 'contract', verb: 'delete', is_read: false, is_destructive: true, requires_confirmation: true, requires_superuser: false },
    { id: 'bulwark.obligation.read', app: 'bulwark', resource: 'obligation', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.obligation.write', app: 'bulwark', resource: 'obligation', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.deadline.read', app: 'bulwark', resource: 'deadline', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.deadline.write', app: 'bulwark', resource: 'deadline', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.notice.draft', app: 'bulwark', resource: 'notice', verb: 'draft', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.compliance.read', app: 'bulwark', resource: 'compliance', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.compliance.chase', app: 'bulwark', resource: 'compliance', verb: 'chase', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.settings.read', app: 'bulwark', resource: 'settings', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'bulwark.settings.write', app: 'bulwark', resource: 'settings', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    // Burn (spec section 11.2). Same satellite deferral as basis/braid/bulwark: burn-api is
    // not in APP_TO_PREFIX and its burn_ MCP tools are deliberately kept out of
    // EXPLICIT_TOOL_OVERRIDES, so neither the route nor the tool scanner emits these ids.
    // Hand-authored with EXPLICIT is_read on every row; the copy loop below takes the flags
    // verbatim.
    //
    // Only burn.engagement.delete is manifest-destructive. The reject and gate-weakening
    // confirm boundaries live at the MCP tool layer (burn_reject_deliverable,
    // burn_set_gate_mode when the target weakens enforcement), NOT on the manifest rows.
    //
    // Two rows exist specifically because a mutation must never be authorized by an
    // is_read:true permission: burn.variance.write is separate from burn.variance.read, and
    // burn.rule.write is separate from burn.attribution.write (rules are one of the three
    // gate-neutralization vectors, so they are owner/admin).
    //
    // burn.precheck.override is deliberately MEMBER tier: the escape hatch on a blocking
    // gate has to stay reachable by the person the gate blocked, or the gate becomes an
    // outage. burn.precheck.mark_wrong is owner/admin because it is the ONLY writer of the
    // demotion numerator.
    //
    // Built-in tiering (asserted by the group-defaults probe in spec 3.4.1):
    //   owner 22, admin 22, member 14, viewer 7, guest 0.
    // Keep in sync with the burn rows in the delta migration and the group-defaults file.
    { id: 'burn.engagement.read', app: 'burn', resource: 'engagement', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.engagement.write', app: 'burn', resource: 'engagement', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.engagement.delete', app: 'burn', resource: 'engagement', verb: 'delete', is_read: false, is_destructive: true, requires_confirmation: true, requires_superuser: false },
    { id: 'burn.deliverable.read', app: 'burn', resource: 'deliverable', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.deliverable.write', app: 'burn', resource: 'deliverable', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.envelope.confirm', app: 'burn', resource: 'envelope', verb: 'confirm', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.attribution.read', app: 'burn', resource: 'attribution', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.attribution.write', app: 'burn', resource: 'attribution', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.rule.write', app: 'burn', resource: 'rule', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.precheck.run', app: 'burn', resource: 'precheck', verb: 'run', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.precheck.read', app: 'burn', resource: 'precheck', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.precheck.override', app: 'burn', resource: 'precheck', verb: 'override', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.precheck.mark_wrong', app: 'burn', resource: 'precheck', verb: 'mark_wrong', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.variance.read', app: 'burn', resource: 'variance', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.variance.write', app: 'burn', resource: 'variance', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.changeorder.draft', app: 'burn', resource: 'changeorder', verb: 'draft', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.financials.read', app: 'burn', resource: 'financials', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.financials.read_all', app: 'burn', resource: 'financials', verb: 'read_all', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.costrate.read', app: 'burn', resource: 'costrate', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.costrate.write', app: 'burn', resource: 'costrate', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.settings.read', app: 'burn', resource: 'settings', verb: 'read', is_read: true, is_destructive: false, requires_confirmation: false, requires_superuser: false },
    { id: 'burn.settings.write', app: 'burn', resource: 'settings', verb: 'write', is_read: false, is_destructive: false, requires_confirmation: false, requires_superuser: false },
  ];
  for (const c of HAND_AUTHORED) {
    if (!byId.has(c.id)) {
      // App defaults to 'bam' (Wave B/F admin surfaces all live there); any
      // entry that targets a different product must set c.app explicitly
      // (e.g. the banter.admin_import.* trio).
      const app = c.app ?? 'bam';
      // Pick the most informative source label we can without rebuilding the
      // full migration map. The id itself carries the app, so the heuristic
      // is "which delta seeded this row first":
      //   divergence → 0146 (Wave B)
      //   banter.admin_import → 0168 (Slack import, this wave)
      //   everything else → 0160 (Wave F SU permissions editor + deploy)
      let migrationLabel = '0160';
      let sourceFile = 'permissions-admin.routes.ts';
      if (c.id.includes('divergence')) migrationLabel = '0146';
      if (c.id.startsWith('banter.admin_import.')) {
        migrationLabel = '0168';
        sourceFile = 'slack-import.routes.ts';
      }
      if (c.id.startsWith('basis.')) {
        migrationLabel = '0229';
        sourceFile = 'metrics.routes.ts';
      }
      if (c.id.startsWith('braid.')) {
        migrationLabel = '0232';
        sourceFile = 'braid.routes.ts';
      }
      if (c.id.startsWith('bulwark.')) {
        migrationLabel = '0237';
        sourceFile = 'bulwark.routes.ts';
      }
      if (c.id.startsWith('burn.')) {
        migrationLabel = '0242';
        sourceFile = 'burn.routes.ts';
      }
      byId.set(c.id, {
        id: c.id,
        app,
        resource: c.resource,
        verb: c.verb,
        is_destructive: c.is_destructive,
        is_read: c.is_read,
        requires_confirmation: c.requires_confirmation,
        requires_superuser: c.requires_superuser,
        sources: [{ source: 'rest', ref: `hand_authored (migration ${migrationLabel})`, file: sourceFile }],
      });
    }
  }

  const sorted = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

  // NOTE: no generated_at timestamp here. The drift guard
  // (scripts/check-permission-catalog.mjs) needs the manifest to be
  // deterministic from the inputs alone; a timestamp would falsely
  // report drift on every run. git log records when the file was
  // committed if needed.
  return {
    counts: {
      total: sorted.length,
      mcp_tools_scanned: tools.length,
      rest_routes_scanned: routes.length,
      read_permissions: sorted.filter((p) => p.is_read).length,
      destructive_permissions: sorted.filter((p) => p.is_destructive).length,
    },
    permissions: sorted,
    unmapped_tools: tools.filter((t) => !t.inferred || !t.inferred.id).map((t) => ({ tool: t.tool_name, file: t.file })),
    unmapped_routes: routes.filter((r) => !r.inferred || !r.inferred.id).map((r) => ({ method: r.method, path: r.path, app: r.app })),
  };
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const manifest = buildManifest();
  writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ wrote ${OUTPUT_PATH}`);
  console.log(`  total permissions: ${manifest.counts.total}`);
  console.log(`  mcp tools scanned: ${manifest.counts.mcp_tools_scanned}`);
  console.log(`  rest routes scanned: ${manifest.counts.rest_routes_scanned}`);
  console.log(`  read permissions:   ${manifest.counts.read_permissions}`);
  console.log(`  destructive:        ${manifest.counts.destructive_permissions}`);
  if (manifest.unmapped_tools.length > 0) {
    console.warn(`  ⚠ ${manifest.unmapped_tools.length} unmapped tools:`);
    for (const t of manifest.unmapped_tools.slice(0, 10)) console.warn(`    - ${t.tool} (${t.file})`);
    if (manifest.unmapped_tools.length > 10) console.warn(`    ... and ${manifest.unmapped_tools.length - 10} more`);
  }
  if (manifest.unmapped_routes.length > 0) {
    console.warn(`  ⚠ ${manifest.unmapped_routes.length} unmapped routes`);
  }
}

main();
