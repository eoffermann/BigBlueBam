import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  type ConditionDef,
} from '../src/services/condition-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cond(
  field: string,
  operator: string,
  value: unknown = null,
  logic_group: 'and' | 'or' = 'and',
): ConditionDef {
  return { field, operator: operator as any, value, logic_group };
}

// ---------------------------------------------------------------------------
// Single operator tests
// ---------------------------------------------------------------------------

describe('evaluateConditions — single operators', () => {
  it('equals: should pass when values match', () => {
    const result = evaluateConditions(
      [cond('status', 'equals', 'active')],
      { status: 'active' },
    );
    expect(result.passed).toBe(true);
    expect(result.log[0]!.result).toBe(true);
  });

  it('equals: should fail when values differ', () => {
    const result = evaluateConditions(
      [cond('status', 'equals', 'active')],
      { status: 'inactive' },
    );
    expect(result.passed).toBe(false);
  });

  it('not_equals: should pass when values differ', () => {
    const result = evaluateConditions(
      [cond('status', 'not_equals', 'archived')],
      { status: 'active' },
    );
    expect(result.passed).toBe(true);
  });

  it('contains: should pass when substring found (case-insensitive)', () => {
    const result = evaluateConditions(
      [cond('title', 'contains', 'deploy')],
      { title: 'Deploy to Production' },
    );
    expect(result.passed).toBe(true);
  });

  it('not_contains: should pass when substring not found', () => {
    const result = evaluateConditions(
      [cond('title', 'not_contains', 'hotfix')],
      { title: 'Regular Release' },
    );
    expect(result.passed).toBe(true);
  });

  it('starts_with: should pass when value starts with expected (case-insensitive)', () => {
    const result = evaluateConditions(
      [cond('name', 'starts_with', 'Bug')],
      { name: 'BUG-1234: Fix login' },
    );
    expect(result.passed).toBe(true);
  });

  it('ends_with: should pass when value ends with expected', () => {
    const result = evaluateConditions(
      [cond('filename', 'ends_with', '.ts')],
      { filename: 'index.ts' },
    );
    expect(result.passed).toBe(true);
  });

  it('greater_than: should pass when actual > expected', () => {
    const result = evaluateConditions(
      [cond('priority', 'greater_than', 3)],
      { priority: 5 },
    );
    expect(result.passed).toBe(true);
  });

  it('greater_than: should fail when actual <= expected', () => {
    const result = evaluateConditions(
      [cond('priority', 'greater_than', 3)],
      { priority: 2 },
    );
    expect(result.passed).toBe(false);
  });

  it('less_than: should pass when actual < expected', () => {
    const result = evaluateConditions(
      [cond('count', 'less_than', 10)],
      { count: 5 },
    );
    expect(result.passed).toBe(true);
  });

  it('is_empty: should pass for null/undefined/empty string', () => {
    expect(evaluateConditions([cond('field', 'is_empty')], { field: null }).passed).toBe(true);
    expect(evaluateConditions([cond('field', 'is_empty')], { field: '' }).passed).toBe(true);
    expect(evaluateConditions([cond('field', 'is_empty')], { field: '  ' }).passed).toBe(true);
    expect(evaluateConditions([cond('field', 'is_empty')], {}).passed).toBe(true);
    expect(evaluateConditions([cond('field', 'is_empty')], { field: [] }).passed).toBe(true);
  });

  it('is_not_empty: should pass for non-empty values', () => {
    expect(evaluateConditions([cond('field', 'is_not_empty')], { field: 'hello' }).passed).toBe(true);
    expect(evaluateConditions([cond('field', 'is_not_empty')], { field: [1] }).passed).toBe(true);
  });

  it('in: should pass when actual is in the expected list', () => {
    const result = evaluateConditions(
      [cond('priority', 'in', ['high', 'critical'])],
      { priority: 'high' },
    );
    expect(result.passed).toBe(true);
  });

  it('in: should fail when actual is not in the expected list', () => {
    const result = evaluateConditions(
      [cond('priority', 'in', ['high', 'critical'])],
      { priority: 'low' },
    );
    expect(result.passed).toBe(false);
  });

  it('not_in: should pass when actual is not in the list', () => {
    const result = evaluateConditions(
      [cond('status', 'not_in', ['archived', 'deleted'])],
      { status: 'active' },
    );
    expect(result.passed).toBe(true);
  });

  it('matches_regex: should pass when actual matches the pattern', () => {
    const result = evaluateConditions(
      [cond('email', 'matches_regex', '^.*@example\\.com$')],
      { email: 'user@example.com' },
    );
    expect(result.passed).toBe(true);
  });

  it('matches_regex: should return false for invalid regex', () => {
    const result = evaluateConditions(
      [cond('field', 'matches_regex', '[invalid')],
      { field: 'test' },
    );
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logic groups
// ---------------------------------------------------------------------------

describe('evaluateConditions — logic groups', () => {
  it('AND group: all must pass', () => {
    const result = evaluateConditions(
      [
        cond('status', 'equals', 'active', 'and'),
        cond('priority', 'equals', 'high', 'and'),
      ],
      { status: 'active', priority: 'high' },
    );
    expect(result.passed).toBe(true);
  });

  it('AND group: fails when any condition fails', () => {
    const result = evaluateConditions(
      [
        cond('status', 'equals', 'active', 'and'),
        cond('priority', 'equals', 'high', 'and'),
      ],
      { status: 'active', priority: 'low' },
    );
    expect(result.passed).toBe(false);
  });

  it('OR group: passes when any condition passes', () => {
    const result = evaluateConditions(
      [
        cond('priority', 'equals', 'high', 'or'),
        cond('priority', 'equals', 'critical', 'or'),
      ],
      { priority: 'critical' },
    );
    expect(result.passed).toBe(true);
  });

  it('OR group: fails when no condition passes', () => {
    const result = evaluateConditions(
      [
        cond('priority', 'equals', 'high', 'or'),
        cond('priority', 'equals', 'critical', 'or'),
      ],
      { priority: 'low' },
    );
    expect(result.passed).toBe(false);
  });

  it('Mixed AND + OR: AND all pass AND at least one OR passes', () => {
    const result = evaluateConditions(
      [
        cond('status', 'equals', 'active', 'and'),
        cond('priority', 'equals', 'high', 'or'),
        cond('priority', 'equals', 'critical', 'or'),
      ],
      { status: 'active', priority: 'critical' },
    );
    expect(result.passed).toBe(true);
  });

  it('Mixed AND + OR: fails when AND condition fails', () => {
    const result = evaluateConditions(
      [
        cond('status', 'equals', 'active', 'and'),
        cond('priority', 'equals', 'high', 'or'),
      ],
      { status: 'inactive', priority: 'high' },
    );
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dot-path field resolution
// ---------------------------------------------------------------------------

describe('evaluateConditions — dot-path resolution', () => {
  it('should resolve nested field paths', () => {
    const result = evaluateConditions(
      [cond('task.assignee.email', 'equals', 'alice@example.com')],
      { task: { assignee: { email: 'alice@example.com' } } },
    );
    expect(result.passed).toBe(true);
  });

  it('should return false gracefully for missing nested field', () => {
    const result = evaluateConditions(
      [cond('task.assignee.email', 'equals', 'alice@example.com')],
      { task: {} },
    );
    expect(result.passed).toBe(false);
  });

  it('should return false gracefully for completely missing field', () => {
    const result = evaluateConditions(
      [cond('nonexistent.path', 'equals', 'value')],
      { other: 'data' },
    );
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('evaluateConditions — edge cases', () => {
  it('should pass when conditions array is empty', () => {
    const result = evaluateConditions([], { anything: 'value' });
    expect(result.passed).toBe(true);
    expect(result.log).toHaveLength(0);
  });

  it('should handle null payload fields gracefully', () => {
    const result = evaluateConditions(
      [cond('field', 'equals', 'value')],
      { field: null },
    );
    expect(result.passed).toBe(false);
    expect(result.log[0]!.actual).toBeNull();
  });
});
