import { describe, it, expect, vi } from 'vitest';

// #328: Bolt's send_webhook URL check now uses @bigbluebam/egress-guard. The
// local port of the api validator it replaced had no CGNAT range (Alibaba
// metadata 100.100.100.200) and missed v4-mapped IPv6 in the hex form that
// URL.hostname normalizes to, and it never resolved DNS.

vi.mock('../src/db/index.js', () => ({
  db: { execute: vi.fn(async () => []) },
  connection: { end: vi.fn() },
}));
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    LOG_LEVEL: 'info',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    MCP_INTERNAL_URL: 'http://mcp-server:3001',
  },
}));

const { validateActionParameters } = await import('../src/services/automation.service.js');

const webhook = (url: string) => [{ mcp_tool: 'send_webhook', parameters: { url } }] as never;
const ORG = '00000000-0000-0000-0000-000000000001';

describe('send_webhook SSRF guard (egress-guard)', () => {
  it.each([
    'https://100.100.100.200/latest/meta-data',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/',
    'http://localhost:4000/',
  ])('refuses %s in strict mode', async (url) => {
    await expect(validateActionParameters(webhook(url), ORG, 'strict')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('warns instead of throwing in lenient mode', async () => {
    const out = await validateActionParameters(webhook('https://100.100.100.200/x'), ORG, 'lenient');
    expect(out.valid).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/send_webhook/);
  });

  it('accepts a public literal address', async () => {
    const out = await validateActionParameters(webhook('https://93.184.215.14/hook'), ORG, 'strict');
    expect(out.warnings).toEqual([]);
  });
});
