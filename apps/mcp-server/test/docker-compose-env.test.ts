import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards against a recurring class of bug: a new app API is added to the
// stack, env.ts gets a *_API_URL entry with a dev-localhost default, but
// docker-compose.yml's mcp-server environment block is not updated — so at
// runtime the mcp-server calls localhost inside its own container and every
// tool for that app fails with "fetch failed". Banter hit this on 2026-04-21.
describe('mcp-server docker-compose env coverage', () => {
  const repoRoot = join(__dirname, '..', '..', '..');
  const envSource = readFileSync(join(repoRoot, 'apps/mcp-server/src/env.ts'), 'utf8');
  const composeSource = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');

  function extractApiUrlKeys(source: string): string[] {
    const keys = new Set<string>();
    for (const match of source.matchAll(/^\s*([A-Z][A-Z0-9_]*_API_URL)\s*:/gm)) {
      keys.add(match[1]!);
    }
    return [...keys];
  }

  function extractMcpServerEnv(source: string): Set<string> {
    const lines = source.split('\n');
    const mcpStart = lines.findIndex((l) => /^\s{2}mcp-server:\s*$/.test(l));
    if (mcpStart === -1) throw new Error('mcp-server service not found in docker-compose.yml');
    const envStart = lines.findIndex((l, i) => i > mcpStart && /^\s{4}environment:\s*$/.test(l));
    if (envStart === -1) throw new Error('mcp-server.environment block not found');
    const keys = new Set<string>();
    for (let i = envStart + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s{0,4}\S/.test(line) && !/^\s{6}\S/.test(line)) break;
      const match = line.match(/^\s{6}([A-Z][A-Z0-9_]*)\s*:/);
      if (match) keys.add(match[1]!);
    }
    return keys;
  }

  const envApiUrlKeys = extractApiUrlKeys(envSource);
  const mcpEnvKeys = extractMcpServerEnv(composeSource);

  it('env.ts declares at least one *_API_URL key', () => {
    expect(envApiUrlKeys.length).toBeGreaterThan(0);
  });

  // API_INTERNAL_URL points at bam api (already overridden separately).
  // The rest must all be overridden so the container never falls back to
  // a localhost default and silently talks to itself.
  for (const key of envApiUrlKeys) {
    if (key === 'API_INTERNAL_URL') continue;
    it(`docker-compose.yml sets ${key} on mcp-server`, () => {
      expect(mcpEnvKeys.has(key)).toBe(true);
    });
  }
});
