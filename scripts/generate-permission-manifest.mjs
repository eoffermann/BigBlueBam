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
  'helpdesk',
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
  // Drop trailing params.
  while (segments.length > 0 && segments[segments.length - 1].startsWith(':')) {
    segments.pop();
  }
  // Build resource. Multiple non-param segments compose with underscores
  // (NOT dots) so the permission ID stays at exactly three segments
  // app.resource.verb — nested resources like /channels/:id/members
  // become `channel_member`, not `channel.member`. The schema's
  // permissions(app, resource, verb) columns would otherwise be ambiguous.
  const nonParam = segments.filter((s) => !s.startsWith(':'));
  if (nonParam.length === 0) return 'self';
  // Singularize each segment if it ends in 's' (very rough; avoids
  // 'agent_policies' -> 'agent_policie' artifact by special-casing 'ies').
  function singularize(s) {
    if (s.endsWith('ies') && s.length > 3) return s.slice(0, -3) + 'y';
    if (s.endsWith('ses') && s.length > 3) return s.slice(0, -2);  // statuses -> status
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
const EXCLUDED_PATH_PREFIXES = ['/internal/', '/health', '/healthz', '/readyz', '/version'];

function isPathExcluded(routePath) {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => {
    // Normalize: '/internal/' covers '/internal/...' AND '/internal'
    const trimmed = prefix.replace(/\/$/, '');
    return routePath === trimmed || routePath.startsWith(trimmed + '/');
  });
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
