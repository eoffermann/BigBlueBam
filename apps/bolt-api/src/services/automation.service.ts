import { eq, and, or, sql, asc, desc, gt, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  boltAutomations,
  boltAutomationVersions,
  boltConditions,
  boltActions,
  boltSchedules,
} from '../db/schema/index.js';
import { evaluateConditions } from './condition-engine.js';
import { getAvailableActions } from './event-catalog.js';
import { checkUrl } from '@bigbluebam/egress-guard';
import { projectRowsToGraph } from './bolt-graph-compiler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE/ILIKE metacharacters so user input is treated as literal text. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BoltError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'BoltError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Validation: MCP tool allowlist
// ---------------------------------------------------------------------------

const allowedToolsCache = new Set(getAvailableActions().map((a) => a.mcp_tool));

/**
 * Validate that every action references a tool on the allowlist.
 * Throws BoltError(400) if any tool is not permitted.
 */
export function validateActionTools(actions: ActionInput[]): void {
  const invalid = actions
    .map((a) => a.mcp_tool)
    .filter((tool) => !allowedToolsCache.has(tool));

  if (invalid.length > 0) {
    throw new BoltError(
      'INVALID_MCP_TOOL',
      `The following action tools are not allowed: ${invalid.join(', ')}. ` +
        `Allowed tools: ${[...allowedToolsCache].join(', ')}`,
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Validation: Org-scoped action parameters
// ---------------------------------------------------------------------------

/** UUID v4 pattern for quick structural check. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parameter keys that reference cross-app entities we can verify. */
const ORG_SCOPED_ENTITY_KEYS: Record<string, { table: string; orgColumn: string }> = {
  project_id: { table: 'projects', orgColumn: 'org_id' },
  user_id: { table: 'users', orgColumn: 'org_id' },
  assignee_id: { table: 'users', orgColumn: 'org_id' },
};

/**
 * Validate that entity-reference parameters in actions belong to the given org.
 * For `strict` mode (new automations), throws on violation.
 * For `lenient` mode (updates to existing automations), logs a warning and
 * returns a flag so the caller can annotate the response.
 */
export async function validateActionParameters(
  actions: ActionInput[],
  orgId: string,
  mode: 'strict' | 'lenient' = 'strict',
): Promise<{ valid: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  for (const action of actions) {
    // BOLT-004: Block SSRF via send_webhook action
    if (action.mcp_tool === 'send_webhook' && action.parameters) {
      const url = action.parameters.url;
      if (typeof url === 'string') {
        // Shared guard (#328): resolves DNS, so a name pointing at
        // 169.254.169.254 or 10.x is refused, not just literal IPs.
        const urlCheck = await checkUrl(url);
        if (!urlCheck.safe) {
          const msg = `Action "send_webhook" URL is not allowed: ${urlCheck.reason}`;
          if (mode === 'strict') {
            throw new BoltError('SSRF_BLOCKED', msg, 400);
          }
          warnings.push(msg);
        }
      }
    }

    if (!action.parameters) continue;

    for (const [key, value] of Object.entries(action.parameters)) {
      const entityDef = ORG_SCOPED_ENTITY_KEYS[key];
      if (!entityDef) continue;
      if (typeof value !== 'string' || !UUID_RE.test(value)) continue;

      // Query the referenced table to verify org ownership.
      // Table/column names come from our own hardcoded constant, so sql.raw() is safe.
      const rows: any[] = await db.execute(
        sql`SELECT id FROM ${sql.raw(entityDef.table)}
            WHERE id = ${value} AND ${sql.raw(entityDef.orgColumn)} = ${orgId}
            LIMIT 1`,
      );

      if (rows.length === 0) {
        const msg =
          `Action "${action.mcp_tool}" references ${key}="${value}" ` +
          `which does not belong to your organization or does not exist.`;

        if (mode === 'strict') {
          throw new BoltError('CROSS_ORG_REFERENCE', msg, 400);
        }
        warnings.push(msg);
      }
    }
  }

  return { valid: warnings.length === 0, warnings };
}

// ---------------------------------------------------------------------------
// Recursion / loop detection (BOLT-005)
// ---------------------------------------------------------------------------

/** Default max chain depth for automation execution. */
export const DEFAULT_MAX_CHAIN_DEPTH = 5;

/**
 * Mapping from MCP tool names to the event(s) they would produce.
 * Used to detect self-triggering automations at creation/update time.
 */
const TOOL_TO_PRODUCED_EVENTS: Record<string, string[]> = {
  // Bam
  create_task: ['task.created'],
  update_task: ['task.updated', 'task.assigned', 'task.moved'],
  move_task: ['task.moved', 'task.updated'],
  delete_task: ['task.deleted'],
  bulk_update_tasks: ['task.updated'],
  duplicate_task: ['task.created'],
  add_comment: ['comment.created'],
  create_sprint: [],
  start_sprint: ['sprint.started'],
  complete_sprint: ['sprint.completed'],

  // Banter
  banter_post_message: ['message.posted'],
  banter_send_dm: ['message.posted'],
  banter_send_group_dm: ['message.posted'],
  banter_create_channel: ['channel.created'],
  banter_react: ['reaction.added'],
  banter_share_task: ['message.posted'],
  banter_share_sprint: ['message.posted'],
  banter_share_ticket: ['message.posted'],

  // Beacon
  beacon_create: ['beacon.created'],
  beacon_update: ['beacon.updated'],
  beacon_publish: ['beacon.published'],
  beacon_verify: ['beacon.verified'],
  beacon_challenge: ['beacon.challenged'],

  // Brief
  brief_create: ['document.created'],
  brief_update: ['document.updated'],
  brief_update_content: ['document.updated'],
  brief_append_content: ['document.updated'],

  // Helpdesk
  reply_to_ticket: ['ticket.replied'],
  update_ticket_status: ['ticket.status_changed'],

  // Bond
  bond_create_contact: ['contact.created'],
  bond_create_deal: ['deal.created'],
  bond_update_deal: ['deal.updated'],
  bond_move_deal_stage: ['deal.stage_changed', 'deal.updated'],
  bond_close_deal_won: ['deal.won', 'deal.stage_changed'],
  bond_close_deal_lost: ['deal.lost', 'deal.stage_changed'],
  bond_log_activity: ['activity.logged'],

  // Blast
  blast_draft_campaign: ['campaign.created'],
  blast_send_campaign: ['campaign.sent'],

  // Board
  board_create: ['board.created'],
  board_update: ['board.updated'],

  // Bearing
  bearing_goal_create: ['goal.created'],
  bearing_goal_update: ['goal.updated'],
  bearing_kr_update: ['key_result.updated'],

  // Bill
  bill_create_invoice: ['invoice.created'],
  bill_create_invoice_from_time: ['invoice.created'],
  bill_create_invoice_from_deal: ['invoice.created'],
  bill_finalize_invoice: ['invoice.finalized'],
  bill_record_payment: ['payment.recorded'],

  // Book
  book_create_event: ['event.created'],
  book_update_event: ['event.updated'],

  // Blank
  blank_publish_form: ['form.published'],
};

/**
 * Detect if an automation's trigger_event matches any event produced by its own actions.
 * Returns a list of warning messages (empty if no recursion risk detected).
 */
export function detectSelfTrigger(
  triggerEvent: string,
  actions: { mcp_tool: string }[],
): string[] {
  const warnings: string[] = [];

  for (const action of actions) {
    const producedEvents = TOOL_TO_PRODUCED_EVENTS[action.mcp_tool];
    if (!producedEvents) continue;

    if (producedEvents.includes(triggerEvent)) {
      warnings.push(
        `Potential infinite loop: trigger "${triggerEvent}" can be re-fired by action "${action.mcp_tool}". ` +
          `Execution will be capped at max_chain_depth to prevent runaway chains.`,
      );
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerSource =
  | 'bam'
  | 'banter'
  | 'beacon'
  | 'brief'
  | 'helpdesk'
  | 'schedule'
  | 'bond'
  | 'blast'
  | 'board'
  | 'bench'
  | 'bearing'
  | 'bill'
  | 'book'
  | 'blank';
export type ConditionOperator =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than'
  | 'is_empty' | 'is_not_empty' | 'in' | 'not_in' | 'matches_regex';
export type LogicGroup = 'and' | 'or';
export type OnError = 'stop' | 'continue' | 'retry';

export interface ConditionInput {
  sort_order: number;
  field: string;
  operator: ConditionOperator;
  value?: unknown;
  logic_group?: LogicGroup;
}

export interface ActionInput {
  sort_order: number;
  mcp_tool: string;
  parameters?: Record<string, unknown>;
  on_error?: OnError;
  retry_count?: number;
  retry_delay_ms?: number;
}

export interface CreateAutomationInput {
  name: string;
  description?: string | null;
  project_id?: string | null;
  enabled?: boolean;
  trigger_source: TriggerSource;
  trigger_event: string;
  trigger_filter?: Record<string, unknown> | null;
  cron_expression?: string | null;
  cron_timezone?: string;
  max_executions_per_hour?: number;
  cooldown_seconds?: number;
  conditions?: ConditionInput[];
  actions: ActionInput[];
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string | null;
  project_id?: string | null;
  enabled?: boolean;
  trigger_source?: TriggerSource;
  trigger_event?: string;
  trigger_filter?: Record<string, unknown> | null;
  cron_expression?: string | null;
  cron_timezone?: string;
  max_executions_per_hour?: number;
  cooldown_seconds?: number;
  conditions?: ConditionInput[];
  actions?: ActionInput[];
}

/** Synthesize a graph from the full automation result for read responses. */
function attachGraph<T extends {
  trigger_source: string;
  trigger_event: string;
  trigger_filter: unknown;
  graph?: unknown;
  conditions: any[];
  actions: any[];
}>(automation: T): T & { graph: unknown } {
  if (automation.graph != null) {
    return automation as T & { graph: unknown };
  }
  const graph = projectRowsToGraph({
    trigger: {
      source: automation.trigger_source,
      event: automation.trigger_event,
      filter: (automation.trigger_filter as Record<string, unknown>) ?? {},
    },
    conditions: automation.conditions,
    actions: automation.actions,
  });
  return { ...automation, graph };
}

export interface PatchAutomationInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
}

export interface ListAutomationFilters {
  orgId: string;
  projectId?: string;
  triggerSource?: string;
  enabled?: boolean;
  search?: string;
  cursor?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listAutomations(filters: ListAutomationFilters) {
  const conditions = [eq(boltAutomations.org_id, filters.orgId)];

  if (filters.projectId) {
    conditions.push(eq(boltAutomations.project_id, filters.projectId));
  }

  if (filters.triggerSource) {
    conditions.push(eq(boltAutomations.trigger_source, filters.triggerSource as TriggerSource));
  }

  if (filters.enabled !== undefined) {
    conditions.push(eq(boltAutomations.enabled, filters.enabled));
  }

  if (filters.search) {
    const escaped = escapeLike(filters.search);
    conditions.push(
      or(
        ilike(boltAutomations.name, `%${escaped}%`),
        ilike(boltAutomations.description, `%${escaped}%`),
      )!,
    );
  }

  const limit = Math.min(filters.limit ?? 50, 100);

  if (filters.cursor) {
    conditions.push(gt(boltAutomations.created_at, new Date(filters.cursor)));
  }

  const rows = await db
    .select()
    .from(boltAutomations)
    .where(and(...conditions))
    .orderBy(asc(boltAutomations.created_at))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && data.length > 0 ? data[data.length - 1]!.created_at.toISOString() : null;

  return {
    data,
    meta: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function getAutomation(id: string, orgId: string) {
  const [automation] = await db
    .select()
    .from(boltAutomations)
    .where(and(eq(boltAutomations.id, id), eq(boltAutomations.org_id, orgId)))
    .limit(1);

  if (!automation) return null;

  const conditions = await db
    .select()
    .from(boltConditions)
    .where(eq(boltConditions.automation_id, id))
    .orderBy(asc(boltConditions.sort_order));

  const actions = await db
    .select()
    .from(boltActions)
    .where(eq(boltActions.automation_id, id))
    .orderBy(asc(boltActions.sort_order));

  const full = { ...automation, conditions, actions };
  return attachGraph(full);
}

export async function getAutomationById(id: string, orgId: string) {
  const [automation] = await db
    .select()
    .from(boltAutomations)
    .where(and(eq(boltAutomations.id, id), eq(boltAutomations.org_id, orgId)))
    .limit(1);
  return automation ?? null;
}

/**
 * Resolve an automation by its name within an org. Prefers an exact
 * case-insensitive match; falls back to a single ILIKE "%name%" hit when
 * exactly one row contains the query as a substring. Returns null if no
 * match is found or the fuzzy fallback is ambiguous (>1 row).
 *
 * Result shape is resolver-friendly and excludes conditions/actions; it
 * includes an `action_count` aggregate and the automation's
 * `last_executed_at` (aliased as `last_execution_at` for external callers).
 */
export async function getAutomationByName(
  name: string,
  orgId: string,
): Promise<
  | {
      id: string;
      name: string;
      description: string | null;
      trigger_source: string;
      trigger_event: string;
      enabled: boolean;
      action_count: number;
      last_execution_at: Date | null;
    }
  | null
> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;

  // 1) Exact case-insensitive match first.
  const exactRows = await db
    .select()
    .from(boltAutomations)
    .where(
      and(
        eq(boltAutomations.org_id, orgId),
        ilike(boltAutomations.name, trimmed),
      ),
    )
    .limit(2);

  let row = exactRows[0];

  // 2) Fuzzy fallback: single-hit ILIKE %trimmed%.
  if (!row) {
    const escaped = escapeLike(trimmed);
    const fuzzyRows = await db
      .select()
      .from(boltAutomations)
      .where(
        and(
          eq(boltAutomations.org_id, orgId),
          ilike(boltAutomations.name, `%${escaped}%`),
        ),
      )
      .orderBy(asc(boltAutomations.created_at))
      .limit(2);

    // Only accept the fuzzy hit if it's unambiguous.
    if (fuzzyRows.length === 1) {
      row = fuzzyRows[0];
    }
  }

  if (!row) return null;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(boltActions)
    .where(eq(boltActions.automation_id, row.id));

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trigger_source: row.trigger_source,
    trigger_event: row.trigger_event,
    enabled: row.enabled,
    action_count: Number(countRow?.count ?? 0),
    last_execution_at: row.last_executed_at,
  };
}

export async function createAutomation(
  data: CreateAutomationInput,
  userId: string,
  orgId: string,
  graphBlob?: unknown,
  graphMode?: string | null,
) {
  // Defense-in-depth: validate tool allowlist at service layer
  validateActionTools(data.actions);

  // Validate that entity references in action parameters belong to the org
  await validateActionParameters(data.actions, orgId, 'strict');

  // BOLT-005: Detect self-triggering / recursive automations
  const loopWarnings = detectSelfTrigger(data.trigger_event, data.actions);

  return await db.transaction(async (tx) => {
    const [automation] = await tx
      .insert(boltAutomations)
      .values({
        org_id: orgId,
        project_id: data.project_id ?? null,
        name: data.name,
        description: data.description ?? null,
        enabled: data.enabled ?? true,
        trigger_source: data.trigger_source,
        trigger_event: data.trigger_event,
        trigger_filter: data.trigger_filter ?? null,
        cron_expression: data.cron_expression ?? null,
        cron_timezone: data.cron_timezone ?? 'UTC',
        max_executions_per_hour: data.max_executions_per_hour ?? 100,
        cooldown_seconds: data.cooldown_seconds ?? 0,
        max_chain_depth: DEFAULT_MAX_CHAIN_DEPTH,
        graph: graphBlob ?? null,
        graph_mode: graphMode ?? null,
        data_version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .returning();

    const automationId = automation!.id;

    // Insert conditions
    let insertedConditions: any[] = [];
    if (data.conditions && data.conditions.length > 0) {
      insertedConditions = await tx
        .insert(boltConditions)
        .values(
          data.conditions.map((c) => ({
            automation_id: automationId,
            sort_order: c.sort_order,
            field: c.field,
            operator: c.operator,
            value: c.value ?? null,
            logic_group: c.logic_group ?? 'and',
          })),
        )
        .returning();
    }

    // Insert actions
    const insertedActions = await tx
      .insert(boltActions)
      .values(
        data.actions.map((a) => ({
          automation_id: automationId,
          sort_order: a.sort_order,
          mcp_tool: a.mcp_tool,
          parameters: a.parameters ?? null,
          on_error: a.on_error ?? 'stop',
          retry_count: a.retry_count ?? 0,
          retry_delay_ms: a.retry_delay_ms ?? 1000,
        })),
      )
      .returning();

    // If schedule trigger, create schedule entry
    if (data.trigger_source === 'schedule' && data.cron_expression) {
      await tx.insert(boltSchedules).values({
        automation_id: automationId,
        next_run_at: null,
        last_run_at: null,
      });
    }

    return {
      ...automation!,
      conditions: insertedConditions,
      actions: insertedActions,
      ...(loopWarnings.length > 0 ? { _warnings: loopWarnings } : {}),
    };
  });
}

export async function updateAutomation(
  id: string,
  data: UpdateAutomationInput,
  userId: string,
  orgId: string,
  graphBlob?: unknown,
  graphMode?: string | null,
) {
  const existing = await getAutomationById(id, orgId);
  if (!existing) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  // Defense-in-depth: validate tool allowlist at service layer (updates)
  if (data.actions && data.actions.length > 0) {
    validateActionTools(data.actions);

    // Lenient mode for existing automations: warn but allow
    const paramResult = await validateActionParameters(data.actions, orgId, 'lenient');
    if (!paramResult.valid) {
      // Log warnings for existing automations that reference cross-org resources
      console.warn(
        `[bolt] Automation ${id} update has cross-org parameter warnings:`,
        paramResult.warnings,
      );
    }
  }

  // BOLT-005: Detect self-triggering on updates
  const effectiveTriggerEvent = data.trigger_event ?? existing.trigger_event;
  const effectiveActions = data.actions ?? [];
  const loopWarnings = effectiveActions.length > 0
    ? detectSelfTrigger(effectiveTriggerEvent, effectiveActions)
    : [];

  const result = await db.transaction(async (tx) => {
    const updateValues: Record<string, unknown> = {
      updated_at: new Date(),
      updated_by: userId,
    };

    if (data.name !== undefined) updateValues.name = data.name;
    if (data.description !== undefined) updateValues.description = data.description;
    if (data.project_id !== undefined) updateValues.project_id = data.project_id;
    if (data.enabled !== undefined) updateValues.enabled = data.enabled;
    if (data.trigger_source !== undefined) updateValues.trigger_source = data.trigger_source;
    if (data.trigger_event !== undefined) updateValues.trigger_event = data.trigger_event;
    if (data.trigger_filter !== undefined) updateValues.trigger_filter = data.trigger_filter;
    if (data.cron_expression !== undefined) updateValues.cron_expression = data.cron_expression;
    if (data.cron_timezone !== undefined) updateValues.cron_timezone = data.cron_timezone;
    if (data.max_executions_per_hour !== undefined)
      updateValues.max_executions_per_hour = data.max_executions_per_hour;
    if (data.cooldown_seconds !== undefined) updateValues.cooldown_seconds = data.cooldown_seconds;
    // Always persist graph state: if graphBlob is provided, store it and set
    // graph_mode; if absent (graphBlob === undefined/null), clear both columns
    // so the next GET re-synthesizes the graph from rows.
    updateValues.graph = graphBlob ?? null;
    updateValues.graph_mode = graphMode ?? null;

    const [automation] = await tx
      .update(boltAutomations)
      .set(updateValues)
      .where(eq(boltAutomations.id, id))
      .returning();

    // Replace conditions if provided
    let insertedConditions: any[] = [];
    if (data.conditions !== undefined) {
      await tx.delete(boltConditions).where(eq(boltConditions.automation_id, id));
      if (data.conditions.length > 0) {
        insertedConditions = await tx
          .insert(boltConditions)
          .values(
            data.conditions.map((c) => ({
              automation_id: id,
              sort_order: c.sort_order,
              field: c.field,
              operator: c.operator,
              value: c.value ?? null,
              logic_group: c.logic_group ?? 'and',
            })),
          )
          .returning();
      }
    } else {
      insertedConditions = await tx
        .select()
        .from(boltConditions)
        .where(eq(boltConditions.automation_id, id))
        .orderBy(asc(boltConditions.sort_order));
    }

    // Replace actions if provided
    let insertedActions: any[] = [];
    if (data.actions !== undefined) {
      await tx.delete(boltActions).where(eq(boltActions.automation_id, id));
      if (data.actions.length > 0) {
        insertedActions = await tx
          .insert(boltActions)
          .values(
            data.actions.map((a) => ({
              automation_id: id,
              sort_order: a.sort_order,
              mcp_tool: a.mcp_tool,
              parameters: a.parameters ?? null,
              on_error: a.on_error ?? 'stop',
              retry_count: a.retry_count ?? 0,
              retry_delay_ms: a.retry_delay_ms ?? 1000,
            })),
          )
          .returning();
      }
    } else {
      insertedActions = await tx
        .select()
        .from(boltActions)
        .where(eq(boltActions.automation_id, id))
        .orderBy(asc(boltActions.sort_order));
    }

    // Manage schedule entry
    const triggerSource = data.trigger_source ?? existing.trigger_source;
    const cronExpression = data.cron_expression ?? existing.cron_expression;
    if (triggerSource === 'schedule' && cronExpression) {
      const [existingSchedule] = await tx
        .select()
        .from(boltSchedules)
        .where(eq(boltSchedules.automation_id, id))
        .limit(1);
      if (!existingSchedule) {
        await tx.insert(boltSchedules).values({
          automation_id: id,
          next_run_at: null,
          last_run_at: null,
        });
      }
    } else {
      await tx.delete(boltSchedules).where(eq(boltSchedules.automation_id, id));
    }

    return {
      ...automation!,
      conditions: insertedConditions,
      actions: insertedActions,
      ...(loopWarnings.length > 0 ? { _warnings: loopWarnings } : {}),
    };
  });

  // Fire-and-forget: snapshot the updated state for version history.
  // Errors here should never break the update flow.
  snapshotAutomationVersion(id, userId).catch(() => {});

  return result;
}

export async function patchAutomation(
  id: string,
  data: PatchAutomationInput,
  userId: string,
  orgId: string,
) {
  const existing = await getAutomationById(id, orgId);
  if (!existing) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
    updated_by: userId,
  };

  if (data.name !== undefined) updateValues.name = data.name;
  if (data.description !== undefined) updateValues.description = data.description;
  if (data.enabled !== undefined) updateValues.enabled = data.enabled;

  const [automation] = await db
    .update(boltAutomations)
    .set(updateValues)
    .where(eq(boltAutomations.id, id))
    .returning();

  return automation!;
}

export async function deleteAutomation(id: string, orgId: string) {
  const existing = await getAutomationById(id, orgId);
  if (!existing) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  await db.delete(boltAutomations).where(eq(boltAutomations.id, id));
  return { deleted: true };
}

export async function enableAutomation(id: string, userId: string, orgId: string) {
  const existing = await getAutomationById(id, orgId);
  if (!existing) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  if (existing.enabled) {
    throw new BoltError('BAD_REQUEST', 'Automation is already enabled', 400);
  }

  const [automation] = await db
    .update(boltAutomations)
    .set({ enabled: true, updated_at: new Date(), updated_by: userId })
    .where(eq(boltAutomations.id, id))
    .returning();

  return automation!;
}

export async function disableAutomation(id: string, userId: string, orgId: string) {
  const existing = await getAutomationById(id, orgId);
  if (!existing) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  if (!existing.enabled) {
    throw new BoltError('BAD_REQUEST', 'Automation is already disabled', 400);
  }

  const [automation] = await db
    .update(boltAutomations)
    .set({ enabled: false, updated_at: new Date(), updated_by: userId })
    .where(eq(boltAutomations.id, id))
    .returning();

  return automation!;
}

export async function duplicateAutomation(id: string, userId: string, orgId: string) {
  const full = await getAutomation(id, orgId);
  if (!full) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  const newName = `${full.name} (copy)`;

  return await createAutomation(
    {
      name: newName,
      description: full.description,
      project_id: full.project_id,
      enabled: false, // Duplicates start disabled
      trigger_source: full.trigger_source as TriggerSource,
      trigger_event: full.trigger_event,
      trigger_filter: full.trigger_filter as Record<string, unknown> | null,
      cron_expression: full.cron_expression,
      cron_timezone: full.cron_timezone,
      max_executions_per_hour: full.max_executions_per_hour,
      cooldown_seconds: full.cooldown_seconds,
      conditions: full.conditions.map((c) => ({
        sort_order: c.sort_order,
        field: c.field,
        operator: c.operator as ConditionOperator,
        value: c.value,
        logic_group: (c.logic_group ?? 'and') as LogicGroup,
      })),
      actions: full.actions.map((a) => ({
        sort_order: a.sort_order,
        mcp_tool: a.mcp_tool,
        parameters: a.parameters as Record<string, unknown> | undefined,
        on_error: (a.on_error ?? 'stop') as OnError,
        retry_count: a.retry_count,
        retry_delay_ms: a.retry_delay_ms,
      })),
    },
    userId,
    orgId,
  );
}

export async function testAutomation(
  id: string,
  simulatedEvent: Record<string, unknown>,
  orgId: string,
) {
  const full = await getAutomation(id, orgId);
  if (!full) throw new BoltError('NOT_FOUND', 'Automation not found', 404);

  if (full.conditions.length === 0) {
    return {
      passed: true,
      log: [],
      message: 'No conditions defined; all events would trigger this automation.',
    };
  }

  const result = evaluateConditions(
    full.conditions.map((c) => ({
      field: c.field,
      operator: c.operator as ConditionOperator,
      value: c.value,
      logic_group: (c.logic_group ?? 'and') as LogicGroup,
    })),
    simulatedEvent,
  );

  return {
    passed: result.passed,
    log: result.log,
    message: result.passed
      ? 'All conditions passed. Actions would execute.'
      : 'Conditions not met. Actions would be skipped.',
  };
}

// ---------------------------------------------------------------------------
// Internal worker helper — no org-scoped auth
// ---------------------------------------------------------------------------

/**
 * Lean fetch used by the BullMQ `bolt-execute` worker on every execution.
 *
 * This function intentionally bypasses request-scoped org auth because the
 * worker has no Fastify request context — it receives an `automation_id`
 * directly from the BullMQ job payload, which was already validated at
 * enqueue time by the bolt-api route that created the execution record.
 *
 * Returns exactly the fields the worker needs — automation metadata plus
 * the ordered action list — and nothing else (no conditions, no schedules).
 * Keeping the query surface small matters because this is called on every
 * `bolt:execute` job, making it a hot path.
 *
 * Do NOT use this function from Fastify request handlers; prefer
 * `getAutomation(id, orgId)` there to enforce org isolation.
 */
export async function getAutomationForExecution(id: string): Promise<{
  automation: {
    id: string;
    org_id: string;
    name: string;
    max_chain_depth: number;
    created_by: string;
    template_strict: boolean;
  };
  actions: Array<{
    id: string;
    automation_id: string;
    sort_order: number;
    mcp_tool: string;
    parameters: Record<string, unknown> | null;
    on_error: string;
    retry_count: number;
    retry_delay_ms: number;
  }>;
} | null> {
  const [automation] = await db
    .select({
      id: boltAutomations.id,
      org_id: boltAutomations.org_id,
      name: boltAutomations.name,
      max_chain_depth: boltAutomations.max_chain_depth,
      created_by: boltAutomations.created_by,
      template_strict: boltAutomations.template_strict,
    })
    .from(boltAutomations)
    .where(eq(boltAutomations.id, id))
    .limit(1);

  if (!automation) return null;

  const actions = await db
    .select({
      id: boltActions.id,
      automation_id: boltActions.automation_id,
      sort_order: boltActions.sort_order,
      mcp_tool: boltActions.mcp_tool,
      parameters: boltActions.parameters,
      on_error: boltActions.on_error,
      retry_count: boltActions.retry_count,
      retry_delay_ms: boltActions.retry_delay_ms,
    })
    .from(boltActions)
    .where(eq(boltActions.automation_id, id))
    .orderBy(asc(boltActions.sort_order));

  return {
    automation,
    actions: actions.map((a) => ({
      ...a,
      parameters: (a.parameters as Record<string, unknown> | null) ?? null,
      on_error: a.on_error as string,
    })),
  };
}

export async function getStats(orgId: string, projectId?: string) {
  // Mirror the list endpoint's filtering: when the caller passes a
  // project_id (e.g. the home page sourcing it from the active-project
  // store), scope the counts to that project so the stats card and the
  // list view stay in sync.
  const rows: any[] = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE enabled = TRUE)::int AS enabled,
      COUNT(*) FILTER (WHERE enabled = FALSE)::int AS disabled,
      COUNT(*) FILTER (WHERE trigger_source = 'bam')::int AS source_bam,
      COUNT(*) FILTER (WHERE trigger_source = 'banter')::int AS source_banter,
      COUNT(*) FILTER (WHERE trigger_source = 'beacon')::int AS source_beacon,
      COUNT(*) FILTER (WHERE trigger_source = 'brief')::int AS source_brief,
      COUNT(*) FILTER (WHERE trigger_source = 'helpdesk')::int AS source_helpdesk,
      COUNT(*) FILTER (WHERE trigger_source = 'schedule')::int AS source_schedule,
      COUNT(*) FILTER (WHERE trigger_source = 'bond')::int AS source_bond,
      COUNT(*) FILTER (WHERE trigger_source = 'blast')::int AS source_blast,
      COUNT(*) FILTER (WHERE trigger_source = 'board')::int AS source_board,
      COUNT(*) FILTER (WHERE trigger_source = 'bench')::int AS source_bench,
      COUNT(*) FILTER (WHERE trigger_source = 'bearing')::int AS source_bearing,
      COUNT(*) FILTER (WHERE trigger_source = 'bill')::int AS source_bill,
      COUNT(*) FILTER (WHERE trigger_source = 'book')::int AS source_book,
      COUNT(*) FILTER (WHERE trigger_source = 'blank')::int AS source_blank
    FROM bolt_automations
    WHERE org_id = ${orgId}
      AND (${projectId ?? null}::uuid IS NULL OR project_id = ${projectId ?? null}::uuid)
  `);

  const row = rows[0] ?? {
    total: 0, enabled: 0, disabled: 0,
    source_bam: 0, source_banter: 0, source_beacon: 0,
    source_brief: 0, source_helpdesk: 0, source_schedule: 0,
    source_bond: 0, source_blast: 0, source_board: 0,
    source_bench: 0, source_bearing: 0, source_bill: 0,
    source_book: 0, source_blank: 0,
  };

  return {
    total: row.total,
    enabled: row.enabled,
    disabled: row.disabled,
    by_source: {
      bam: row.source_bam,
      banter: row.source_banter,
      beacon: row.source_beacon,
      brief: row.source_brief,
      helpdesk: row.source_helpdesk,
      schedule: row.source_schedule,
      bond: row.source_bond,
      blast: row.source_blast,
      board: row.source_board,
      bench: row.source_bench,
      bearing: row.source_bearing,
      bill: row.source_bill,
      book: row.source_book,
      blank: row.source_blank,
    },
  };
}

// ---------------------------------------------------------------------------
// Automation versioning
// ---------------------------------------------------------------------------

/**
 * Snapshot the current state of an automation as a new version row.
 * Called automatically on every save (update). Returns the new version number.
 */
export async function snapshotAutomationVersion(
  automationId: string,
  userId: string,
  note?: string,
) {
  // Determine next version number
  const [latest] = await db
    .select({ version: boltAutomationVersions.version })
    .from(boltAutomationVersions)
    .where(eq(boltAutomationVersions.automation_id, automationId))
    .orderBy(desc(boltAutomationVersions.version))
    .limit(1);

  const nextVersion = (latest?.version ?? 0) + 1;

  // Read the current automation row to snapshot
  const [automation] = await db
    .select()
    .from(boltAutomations)
    .where(eq(boltAutomations.id, automationId))
    .limit(1);

  if (!automation) return null;

  // Read conditions and actions for full snapshot
  const conditions = await db
    .select()
    .from(boltConditions)
    .where(eq(boltConditions.automation_id, automationId))
    .orderBy(asc(boltConditions.sort_order));

  const actions = await db
    .select()
    .from(boltActions)
    .where(eq(boltActions.automation_id, automationId))
    .orderBy(asc(boltActions.sort_order));

  const snapshot = {
    name: automation.name,
    description: automation.description,
    enabled: automation.enabled,
    trigger_source: automation.trigger_source,
    trigger_event: automation.trigger_event,
    trigger_filter: automation.trigger_filter,
    cron_expression: automation.cron_expression,
    cron_timezone: automation.cron_timezone,
    max_executions_per_hour: automation.max_executions_per_hour,
    cooldown_seconds: automation.cooldown_seconds,
    max_chain_depth: automation.max_chain_depth,
    template_strict: automation.template_strict,
    notify_owner_on_failure: automation.notify_owner_on_failure,
    graph: automation.graph,
    graph_mode: automation.graph_mode,
    data_version: automation.data_version,
    conditions,
    actions,
  };

  const [versionRow] = await db
    .insert(boltAutomationVersions)
    .values({
      automation_id: automationId,
      version: nextVersion,
      snapshot,
      created_by: userId,
      note: note ?? null,
    })
    .returning();

  return versionRow;
}

/** List all versions for an automation, newest first. */
export async function listAutomationVersions(automationId: string) {
  return db
    .select()
    .from(boltAutomationVersions)
    .where(eq(boltAutomationVersions.automation_id, automationId))
    .orderBy(desc(boltAutomationVersions.version));
}

/**
 * Restore an automation from a specific version snapshot.
 * This overwrites the current automation row with the snapshot values
 * and creates a new version entry recording the restore.
 */
export async function restoreAutomationVersion(
  automationId: string,
  versionId: string,
  userId: string,
  orgId: string,
) {
  const [versionRow] = await db
    .select()
    .from(boltAutomationVersions)
    .where(
      and(
        eq(boltAutomationVersions.id, versionId),
        eq(boltAutomationVersions.automation_id, automationId),
      ),
    )
    .limit(1);

  if (!versionRow) {
    throw new BoltError('NOT_FOUND', 'Version not found', 404);
  }

  const snap = versionRow.snapshot as Record<string, unknown>;

  // Update the automation row from the snapshot
  await db
    .update(boltAutomations)
    .set({
      name: snap.name as string,
      description: (snap.description as string) ?? null,
      enabled: (snap.enabled as boolean) ?? true,
      trigger_source: snap.trigger_source as typeof boltAutomations.$inferInsert.trigger_source,
      trigger_event: snap.trigger_event as string,
      trigger_filter: snap.trigger_filter ?? null,
      cron_expression: (snap.cron_expression as string) ?? null,
      cron_timezone: (snap.cron_timezone as string) ?? 'UTC',
      max_executions_per_hour: (snap.max_executions_per_hour as number) ?? 100,
      cooldown_seconds: (snap.cooldown_seconds as number) ?? 0,
      max_chain_depth: (snap.max_chain_depth as number) ?? 5,
      template_strict: (snap.template_strict as boolean) ?? false,
      notify_owner_on_failure: (snap.notify_owner_on_failure as boolean) ?? false,
      graph: snap.graph ?? null,
      graph_mode: (snap.graph_mode as string) ?? null,
      data_version: (snap.data_version as number) ?? 1,
      updated_by: userId,
      updated_at: new Date(),
    })
    .where(
      and(eq(boltAutomations.id, automationId), eq(boltAutomations.org_id, orgId)),
    );

  // Snapshot the restored state as a new version
  await snapshotAutomationVersion(
    automationId,
    userId,
    `Restored from version ${versionRow.version}`,
  );

  // Return the updated automation
  return getAutomation(automationId, orgId);
}
