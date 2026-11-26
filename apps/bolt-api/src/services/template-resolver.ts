// ---------------------------------------------------------------------------
// Template variable resolver — pure functions, no DB access
// ---------------------------------------------------------------------------

/**
 * Supported variable patterns:
 *   {{ event.field.path }}
 *   {{ actor.field }}
 *   {{ automation.field }}
 *   {{ now }}
 *   {{ step[N].result.field }}
 */

export interface ResolverContext {
  event: Record<string, unknown>;
  actor: Record<string, unknown>;
  automation: Record<string, unknown>;
  stepResults?: Record<number, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function resolveFieldPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (BLOCKED_KEYS.has(part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringify(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Regex matching {{ variable.path }} with optional whitespace
const TEMPLATE_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;

// Regex for step references: step[0].result.field
const STEP_REGEX = /^step\[(\d+)\]\.result\.(.+)$/;

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve template variables in a string using regex replacement.
 * Does NOT use eval or Function constructor.
 */
export function resolveTemplateString(template: string, context: ResolverContext): string {
  return template.replace(TEMPLATE_REGEX, (_match, expr: string) => {
    const trimmed = expr.trim();

    // {{ now }}
    if (trimmed === 'now') {
      return new Date().toISOString();
    }

    // {{ event.field.path }}
    if (trimmed.startsWith('event.')) {
      const path = trimmed.slice(6); // Remove 'event.'
      return stringify(resolveFieldPath(context.event, path));
    }

    // {{ actor.field }}
    if (trimmed.startsWith('actor.')) {
      const path = trimmed.slice(6);
      return stringify(resolveFieldPath(context.actor, path));
    }

    // {{ automation.field }}
    if (trimmed.startsWith('automation.')) {
      const path = trimmed.slice(11);
      return stringify(resolveFieldPath(context.automation, path));
    }

    // {{ step[N].result.field }}
    const stepMatch = STEP_REGEX.exec(trimmed);
    if (stepMatch) {
      const stepIndex = Number.parseInt(stepMatch[1]!, 10);
      const fieldPath = stepMatch[2]!;
      const stepData = context.stepResults?.[stepIndex];
      if (!stepData) return '';
      return stringify(resolveFieldPath(stepData, fieldPath));
    }

    // Unknown variable — return as-is
    return _match;
  });
}

/**
 * Recursively resolve template variables in an object (parameters JSONB).
 * String values are resolved; other types are passed through.
 */
export function resolveTemplateVariables(
  template: unknown,
  context: ResolverContext,
): unknown {
  if (typeof template === 'string') {
    return resolveTemplateString(template, context);
  }

  if (Array.isArray(template)) {
    return template.map((item) => resolveTemplateVariables(item, context));
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      result[key] = resolveTemplateVariables(value, context);
    }
    return result;
  }

  return template;
}
