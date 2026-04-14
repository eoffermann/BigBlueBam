// ---------------------------------------------------------------------------
// Condition evaluation engine: pure functions, no DB access
// ---------------------------------------------------------------------------

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'
  | 'matches_regex';

export type LogicGroup = 'and' | 'or';

export interface ConditionDef {
  field: string;
  operator: ConditionOperator;
  value: unknown;
  logic_group: LogicGroup;
}

export interface ConditionLogEntry {
  field: string;
  operator: string;
  expected: unknown;
  actual: unknown;
  result: boolean;
}

export interface EvaluationResult {
  passed: boolean;
  log: ConditionLogEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-delimited field path against a payload object.
 * e.g. "task.assignee.email" resolves to payload.task.assignee.email
 */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function resolveField(payload: Record<string, unknown>, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (BLOCKED_KEYS.has(part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function coerceString(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  const n = Number(val);
  return Number.isNaN(n) ? 0 : n;
}

function isEmpty(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Single condition evaluator
// ---------------------------------------------------------------------------

function evaluateSingle(operator: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'equals':
      return coerceString(actual) === coerceString(expected);

    case 'not_equals':
      return coerceString(actual) !== coerceString(expected);

    case 'contains':
      return coerceString(actual).toLowerCase().includes(coerceString(expected).toLowerCase());

    case 'not_contains':
      return !coerceString(actual).toLowerCase().includes(coerceString(expected).toLowerCase());

    case 'starts_with':
      return coerceString(actual).toLowerCase().startsWith(coerceString(expected).toLowerCase());

    case 'ends_with':
      return coerceString(actual).toLowerCase().endsWith(coerceString(expected).toLowerCase());

    case 'greater_than':
      return toNumber(actual) > toNumber(expected);

    case 'less_than':
      return toNumber(actual) < toNumber(expected);

    case 'is_empty':
      return isEmpty(actual);

    case 'is_not_empty':
      return !isEmpty(actual);

    case 'in': {
      const list = Array.isArray(expected) ? expected : [expected];
      const actualStr = coerceString(actual);
      return list.some((item) => coerceString(item) === actualStr);
    }

    case 'not_in': {
      const list = Array.isArray(expected) ? expected : [expected];
      const actualStr = coerceString(actual);
      return !list.some((item) => coerceString(item) === actualStr);
    }

    case 'matches_regex': {
      try {
        const pattern = coerceString(expected);
        // Strict pattern length limit to mitigate ReDoS
        if (pattern.length > 100) return false;
        // Reject patterns with obvious ReDoS constructs (nested quantifiers)
        if (
          /(\+|\*|\{)\s*(\+|\*|\?)/.test(pattern) ||
          /\([^)]*(\+|\*)\)[^?]?(\+|\*|\{)/.test(pattern)
        ) {
          return false;
        }
        const regex = new RegExp(pattern);
        // Execute regex with a bounded input length
        const actualStr = coerceString(actual);
        if (actualStr.length > 10_000) return false;
        return regex.test(actualStr);
      } catch {
        // Invalid regex: treat as not matching
        return false;
      }
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a list of conditions against an event payload.
 *
 * Conditions are grouped by `logic_group`:
 *   - 'and' conditions must ALL pass
 *   - 'or' conditions need at least ONE to pass
 *
 * The final result is: (all AND conditions pass) AND (at least one OR condition passes, if any exist).
 */
export function evaluateConditions(
  conditions: ConditionDef[],
  payload: Record<string, unknown>,
): EvaluationResult {
  const log: ConditionLogEntry[] = [];

  const andConditions = conditions.filter((c) => c.logic_group === 'and');
  const orConditions = conditions.filter((c) => c.logic_group === 'or');

  let andPassed = true;
  for (const cond of andConditions) {
    const actual = resolveField(payload, cond.field);
    const result = evaluateSingle(cond.operator, actual, cond.value);
    log.push({
      field: cond.field,
      operator: cond.operator,
      expected: cond.value,
      actual,
      result,
    });
    if (!result) andPassed = false;
  }

  let orPassed = true;
  if (orConditions.length > 0) {
    orPassed = false;
    for (const cond of orConditions) {
      const actual = resolveField(payload, cond.field);
      const result = evaluateSingle(cond.operator, actual, cond.value);
      log.push({
        field: cond.field,
        operator: cond.operator,
        expected: cond.value,
        actual,
        result,
      });
      if (result) orPassed = true;
    }
  }

  return {
    passed: andPassed && orPassed,
    log,
  };
}
