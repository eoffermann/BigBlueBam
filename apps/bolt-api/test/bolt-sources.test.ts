import { describe, it, expect, vi } from 'vitest';
import { BOLT_SOURCES } from '@bigbluebam/shared';

// The ingest route module imports the db and env at load time; stub both so the
// schema can be exercised without a database (issue #124).
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    INTERNAL_SERVICE_SECRET: 'x'.repeat(32),
    MCP_INTERNAL_URL: 'http://mcp-server:3001',
    BBB_API_INTERNAL_URL: 'http://api:4000',
  },
}));

const { ingestEventSchema } = await import('../src/routes/event-ingestion.routes.js');
const { boltTriggerSourceEnum } = await import('../src/db/schema/bolt-automations.js');
const { getEventsBySource, getAllEvents } = await import('../src/services/event-catalog.js');

const ORG = '00000000-0000-0000-0000-000000000001';

function ingest(source: string) {
  return ingestEventSchema.safeParse({ event_type: 'thing.happened', source, payload: {}, org_id: ORG });
}

describe('issue #124: one Bolt source list', () => {
  it('ingest accepts every BOLT_SOURCES value', () => {
    for (const s of BOLT_SOURCES) expect(ingest(s).success, s).toBe(true);
  });

  it('ingest accepts bursar and bastion (the regression and the next app)', () => {
    expect(ingest('bursar').success).toBe(true);
    expect(ingest('bastion').success).toBe(true);
  });

  it('ingest still rejects an unknown source', () => {
    expect(ingest('not-an-app').success).toBe(false);
  });

  it('the Drizzle pgEnum carries exactly BOLT_SOURCES', () => {
    expect([...boltTriggerSourceEnum.enumValues]).toEqual([...BOLT_SOURCES]);
  });

  it('every catalog event source is in BOLT_SOURCES', () => {
    const sources = new Set(getAllEvents().map((e: { source: string }) => e.source));
    for (const s of sources) expect(BOLT_SOURCES as readonly string[], s).toContain(s);
    expect(getEventsBySource('bursar').length).toBeGreaterThan(0);
  });

  // Issue #138: the generated MCP tool schemas must carry the full list. A stale
  // generated file (extractor not re-run after BOLT_SOURCES changed) fails here.
  it('the generated MCP tool schemas carry exactly BOLT_SOURCES for every bolt source field', async () => {
    const { MCP_TOOL_SCHEMAS } = await import('../src/services/mcp-tool-schemas.generated.js');
    const fields: Array<[string, string]> = [
      ['bolt_list', 'trigger_source'],
      ['bolt_create', 'trigger_source'],
      ['bolt_update', 'trigger_source'],
      ['bolt_events', 'source'],
    ];
    for (const [tool, field] of fields) {
      const schema = MCP_TOOL_SCHEMAS.find((t) => t.mcp_tool === tool);
      expect(schema, tool).toBeDefined();
      const param = schema!.parameters.find((p) => p.name === field);
      expect(param?.enum, `${tool}.${field}`).toEqual([...BOLT_SOURCES]);
    }
  });
});
