import { describe, expect, it } from 'vitest';
import { nestBoltPayload } from '@bigbluebam/shared';
import { evaluateConditions } from '../src/services/condition-engine.js';
import { resolveTemplateString } from '../src/services/template-resolver.js';

// Issue #316: Bolt reads payload fields by walking one object level per dot. A publisher that sent
// the literal top-level key 'diagram.id' produced a payload no rule condition, template or trigger
// filter could read. The shared publisher now sends the nested shape; this checks the invariant at
// the point of consumption, Bolt's own resolvers.

const DIAGRAM = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const literal = { 'diagram.id': DIAGRAM, 'diagram.name': 'Island map', 'org.id': ORG, node_count: 4 };

function ctx(event: Record<string, unknown>) {
  return { event, actor: {}, automation: {} };
}

describe('dotted payload keys reach Bolt nested (#316)', () => {
  it('a literal dotted key is unreadable by the condition engine and the template resolver', () => {
    expect(evaluateConditions([{ field: 'diagram.id', operator: 'equals', value: DIAGRAM, logic_group: 'and' }], literal).passed).toBe(false);
    expect(resolveTemplateString('{{event.diagram.name}}', ctx(literal))).not.toBe('Island map');
  });

  it('the payload the shared publisher sends is readable by both', () => {
    const wire = nestBoltPayload(literal);
    const conds = [
      { field: 'diagram.id', operator: 'equals' as const, value: DIAGRAM, logic_group: 'and' as const },
      { field: 'org.id', operator: 'equals' as const, value: ORG, logic_group: 'and' as const },
      { field: 'node_count', operator: 'equals' as const, value: 4, logic_group: 'and' as const },
    ];
    expect(evaluateConditions(conds, wire).passed).toBe(true);
    expect(resolveTemplateString('{{event.diagram.name}} in {{event.org.id}}', ctx(wire))).toBe(`Island map in ${ORG}`);
  });
});
