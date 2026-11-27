import { describe, it, expect } from 'vitest';
import {
  resolveTemplateString,
  resolveTemplateVariables,
  type ResolverContext,
} from '../src/services/template-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    event: {
      task: { id: 'task-1', title: 'Fix Login Bug', priority: 'high', assignee: { name: 'Alice' } },
      actor: { id: 'user-1' },
    },
    actor: { id: 'user-1', name: 'Bob Smith', email: 'bob@example.com' },
    automation: { id: 'auto-1', name: 'My Automation', config: { on_call_agent_id: 'agent-1' } },
    stepResults: {
      0: { id: 'result-0', status: 'success', data: { ticket_id: 'ticket-abc' } },
      1: { id: 'result-1', status: 'failed' },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveTemplateString
// ---------------------------------------------------------------------------

describe('resolveTemplateString', () => {
  it('should resolve {{ event.task.title }}', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Task: {{ event.task.title }}', ctx);
    expect(result).toBe('Task: Fix Login Bug');
  });

  it('should resolve {{ actor.name }}', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('By {{ actor.name }}', ctx);
    expect(result).toBe('By Bob Smith');
  });

  it('should resolve {{ now }} to an ISO date string', () => {
    const ctx = makeContext();
    const before = new Date().toISOString().slice(0, 10);
    const result = resolveTemplateString('Created at {{ now }}', ctx);
    expect(result).toContain('Created at ');
    expect(result).toContain(before);
  });

  it('should resolve {{ automation.name }}', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Automation: {{ automation.name }}', ctx);
    expect(result).toBe('Automation: My Automation');
  });

  it('should resolve {{ step[0].result.id }}', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Result: {{ step[0].result.id }}', ctx);
    expect(result).toBe('Result: result-0');
  });

  it('should resolve nested step result paths', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Ticket: {{ step[0].result.data.ticket_id }}', ctx);
    expect(result).toBe('Ticket: ticket-abc');
  });

  it('should resolve nested event objects', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Assignee: {{ event.task.assignee.name }}', ctx);
    expect(result).toBe('Assignee: Alice');
  });

  it('should return empty string for missing variables', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Missing: {{ event.nonexistent.field }}', ctx);
    expect(result).toBe('Missing: ');
  });

  it('should return empty string for missing step index', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Step: {{ step[99].result.id }}', ctx);
    expect(result).toBe('Step: ');
  });

  it('should handle template with multiple variables', () => {
    const ctx = makeContext();
    const result = resolveTemplateString(
      '{{ actor.name }} created task "{{ event.task.title }}" via {{ automation.name }}',
      ctx,
    );
    expect(result).toBe('Bob Smith created task "Fix Login Bug" via My Automation');
  });

  it('should pass through strings with no variables', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Hello World', ctx);
    expect(result).toBe('Hello World');
  });

  it('should leave unknown variable patterns as-is', () => {
    const ctx = makeContext();
    const result = resolveTemplateString('Unknown: {{ custom.unknown }}', ctx);
    expect(result).toBe('Unknown: {{ custom.unknown }}');
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateVariables (recursive object resolver)
// ---------------------------------------------------------------------------

describe('resolveTemplateVariables', () => {
  it('should resolve string values in objects', () => {
    const ctx = makeContext();
    const result = resolveTemplateVariables(
      { message: 'Hello {{ actor.name }}', count: 5 },
      ctx,
    );
    expect(result).toEqual({ message: 'Hello Bob Smith', count: 5 });
  });

  it('should resolve arrays recursively', () => {
    const ctx = makeContext();
    const result = resolveTemplateVariables(
      ['{{ actor.name }}', '{{ event.task.title }}', 42],
      ctx,
    );
    expect(result).toEqual(['Bob Smith', 'Fix Login Bug', 42]);
  });

  it('should pass through non-string, non-object types', () => {
    const ctx = makeContext();
    expect(resolveTemplateVariables(42, ctx)).toBe(42);
    expect(resolveTemplateVariables(true, ctx)).toBe(true);
    expect(resolveTemplateVariables(null, ctx)).toBeNull();
  });

  it('should resolve nested objects', () => {
    const ctx = makeContext();
    const result = resolveTemplateVariables(
      {
        outer: {
          inner: '{{ event.task.title }}',
          number: 10,
        },
      },
      ctx,
    );
    expect(result).toEqual({
      outer: {
        inner: 'Fix Login Bug',
        number: 10,
      },
    });
  });

  it('should resolve object values that are objects (JSON stringify)', () => {
    const ctx = makeContext();
    // When event.task is resolved and it's an object, it gets JSON.stringified
    const result = resolveTemplateString('Task data: {{ event.task }}', ctx);
    expect(result).toContain('"title":"Fix Login Bug"');
  });
});
