import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LAUNCHPAD_APP_IDS } from '@bigbluebam/shared';
import { registerPlatformTools } from '../src/tools/platform-tools.js';

/**
 * Issue #144: the MCP Launchpad tools must take their app-id enum from
 * LAUNCHPAD_APP_IDS in @bigbluebam/shared (the same const the api uses), never a
 * hand-written copy that drifts as apps are added.
 */
const TOOLS = readFileSync(join(__dirname, '..', 'src', 'tools', 'platform-tools.ts'), 'utf8');

function registeredInputs(): Map<string, Record<string, z.ZodTypeAny>> {
  const inputs = new Map<string, Record<string, z.ZodTypeAny>>();
  const server = {
    tool: (name: string, _description: string, input: Record<string, z.ZodTypeAny>) => {
      inputs.set(name, input);
    },
  };
  registerPlatformTools(server as never, {} as never);
  return inputs;
}

function enumOptions(schema: z.ZodTypeAny): readonly string[] {
  let s: z.ZodTypeAny = schema;
  // Unwrap optional/nullable/array/describe layers down to the enum.
  for (let i = 0; i < 10; i += 1) {
    if (s instanceof z.ZodEnum) return s.options as readonly string[];
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodArray) s = s.element;
    else break;
  }
  throw new Error('no enum found');
}

describe('Launchpad MCP tools derive their app-id enum from LAUNCHPAD_APP_IDS (issue #144)', () => {
  it('imports LAUNCHPAD_APP_IDS from @bigbluebam/shared and has no inline app-id list', () => {
    expect(TOOLS).toMatch(/import \{ LAUNCHPAD_APP_IDS \} from '@bigbluebam\/shared';/);
    const inline = [...TOOLS.matchAll(/z\.enum\(\s*\[([^\]]*)\]/g)].map((m) => m[1]!);
    expect(inline.filter((body) => /'b3'/.test(body) && /'banter'/.test(body))).toEqual([]);
  });

  it('every registered tool that takes an `apps` list accepts exactly the shared ids', () => {
    const inputs = registeredInputs();
    const withApps = [...inputs.entries()].filter(([, input]) => input && 'apps' in input);
    expect(withApps.length).toBeGreaterThanOrEqual(2);
    for (const [, input] of withApps) {
      expect([...enumOptions(input.apps!)]).toEqual([...LAUNCHPAD_APP_IDS]);
    }
  });

  it('the shared list covers every app the suite ships, including the newer ones', () => {
    for (const id of ['blueprint', 'bin', 'bay', 'blip', 'bureau', 'basis', 'braid', 'bulwark', 'burn', 'bursar']) {
      expect(LAUNCHPAD_APP_IDS).toContain(id);
    }
    expect(new Set(LAUNCHPAD_APP_IDS).size).toBe(LAUNCHPAD_APP_IDS.length);
  });
});
