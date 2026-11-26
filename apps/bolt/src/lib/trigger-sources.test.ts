import { describe, expect, it } from 'vitest';
import { BOLT_SOURCES } from '@bigbluebam/shared';
import { automationFormSchema } from './automation-validation';
import {
  TRIGGER_SOURCE_COLORS,
  TRIGGER_SOURCE_LABELS,
  TRIGGER_SOURCE_OPTIONS,
  TRIGGER_SOURCES,
} from './trigger-sources';

describe('Bolt SPA trigger sources (issue #133)', () => {
  it('is exactly the shared BOLT_SOURCES list', () => {
    expect([...TRIGGER_SOURCES]).toEqual([...BOLT_SOURCES]);
    expect(TRIGGER_SOURCE_OPTIONS.map((o) => o.value)).toEqual([...BOLT_SOURCES]);
  });

  it('has a non-empty label and a color for every source', () => {
    for (const source of BOLT_SOURCES) {
      expect(TRIGGER_SOURCE_LABELS[source], `label for ${source}`).toMatch(/\S/);
      expect(TRIGGER_SOURCE_COLORS[source], `color for ${source}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('has no label or color for a source that is not in BOLT_SOURCES', () => {
    const known = new Set<string>(BOLT_SOURCES);
    expect(Object.keys(TRIGGER_SOURCE_LABELS).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(TRIGGER_SOURCE_COLORS).filter((k) => !known.has(k))).toEqual([]);
  });

  it('accepts every shared source in the automation form schema', () => {
    for (const source of BOLT_SOURCES) {
      const result = automationFormSchema.safeParse({
        name: 'x',
        trigger_source: source,
        trigger_event: 'e',
        max_executions_per_hour: 1,
        cooldown_seconds: 0,
      });
      expect(result.success, `source ${source}`).toBe(true);
    }
  });
});
