import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #138: the Bolt MCP tools must take their source enum from BOLT_SOURCES
 * in @bigbluebam/shared, never a hand-written copy of the list.
 */
const TOOLS = readFileSync(join(__dirname, '..', 'src', 'tools', 'bolt-tools.ts'), 'utf8');

function toolInput(name: string): string {
  const start = TOOLS.indexOf(`name: '${name}'`);
  if (start === -1) throw new Error(`tool ${name} not found`);
  const inputIdx = TOOLS.indexOf('input: {', start);
  const returnsIdx = TOOLS.indexOf('returns:', inputIdx);
  return TOOLS.slice(inputIdx, returnsIdx);
}

describe('bolt tools derive their source enum from BOLT_SOURCES (issue #138)', () => {
  it('imports BOLT_SOURCES from @bigbluebam/shared', () => {
    expect(TOOLS).toMatch(/import \{ BOLT_SOURCES \} from '@bigbluebam\/shared';/);
  });

  it.each([
    ['bolt_list', 'trigger_source'],
    ['bolt_create', 'trigger_source'],
    ['bolt_update', 'trigger_source'],
    ['bolt_events', 'source'],
  ])('%s.%s uses z.enum(BOLT_SOURCES)', (tool, field) => {
    expect(toolInput(tool)).toMatch(new RegExp(`${field}: z\\.enum\\(BOLT_SOURCES\\)`));
  });

  it('has no inline enum literal that lists Bolt sources', () => {
    const inline = [...TOOLS.matchAll(/z\.enum\(\s*\[([^\]]*)\]/g)].map((m) => m[1]!);
    const sourceLists = inline.filter((body) => /'bam'/.test(body) && /'banter'/.test(body));
    expect(sourceLists).toEqual([]);
  });
});
