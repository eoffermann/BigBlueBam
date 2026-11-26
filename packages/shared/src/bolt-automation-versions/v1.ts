/**
 * BoltAutomationDataV1 — the canonical shape of an automation's
 * trigger/condition/action data at data_version=1.
 *
 * This type describes what is stored in and read from the bolt_automations,
 * bolt_conditions, and bolt_actions tables at this version of the schema.
 * It is intentionally separate from the HTTP request/response shapes.
 */

import type { BoltSource } from '../bolt-sources.js';

// Derived from the single BOLT_SOURCES list (issue #124); do not hand-list values here.
export type TriggerSourceV1 = BoltSource;

export type ConditionOperatorV1 =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than'
  | 'is_empty' | 'is_not_empty' | 'in' | 'not_in' | 'matches_regex';

export type LogicGroupV1 = 'and' | 'or';
export type OnErrorV1 = 'stop' | 'continue' | 'retry';

export interface ConditionV1 {
  sort_order: number;
  field: string;
  operator: ConditionOperatorV1;
  value?: unknown;
  logic_group: LogicGroupV1;
}

export interface ActionV1 {
  sort_order: number;
  mcp_tool: string;
  parameters?: Record<string, unknown>;
  on_error: OnErrorV1;
  retry_count: number;
  retry_delay_ms: number;
}

export interface BoltAutomationDataV1 {
  /** Human-readable name. */
  name: string;
  description?: string | null;
  project_id?: string | null;
  enabled: boolean;

  /** Trigger configuration. */
  trigger_source: TriggerSourceV1;
  trigger_event: string;
  /** Freeform key/value filter applied to the trigger event payload. */
  trigger_filter?: Record<string, unknown> | null;

  /** Schedule / cron — only relevant when trigger_source === 'schedule'. */
  cron_expression?: string | null;
  cron_timezone: string;

  /** Throttling knobs. */
  max_executions_per_hour: number;
  cooldown_seconds: number;

  /**
   * When true, actions whose template variables cannot be resolved will
   * abort rather than pass through an empty string.
   */
  template_strict: boolean;

  /** Ordered list of conditions (evaluated before actions). */
  conditions: ConditionV1[];

  /** Ordered list of actions to execute. */
  actions: ActionV1[];
}
