import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({
  db: { execute: vi.fn() },
  readDb: { execute: vi.fn() },
  connection: { end: vi.fn() },
  readConnection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4011,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
    QUERY_TIMEOUT_MS: 10000,
    CACHE_TTL_SECONDS: 60,
  },
}));

const ORG_ID = '00000000-0000-0000-0000-000000000001';

describe('Query Builder', () => {
  describe('buildQuery', () => {
    it('builds a simple count query', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count', alias: 'task_count' }],
        },
        ORG_ID,
      );

      expect(pq.text).toContain('SELECT');
      expect(pq.text).toContain('COUNT(id)');
      expect(pq.text).toContain('FROM tasks');
      expect(pq.text).toContain('LIMIT');
    });

    it('builds a grouped query with dimensions', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count', alias: 'task_count' }],
          dimensions: [{ field: 'priority' }],
        },
        ORG_ID,
      );

      expect(pq.text).toContain('priority');
      expect(pq.text).toContain('GROUP BY');
    });

    it('builds a query with filters', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count' }],
          filters: [{ field: 'state', op: 'eq', value: 'done' }],
        },
        ORG_ID,
      );

      // Filter values are now parameterized — verify the clause uses a placeholder
      // and that the value is carried in params.
      expect(pq.text).toMatch(/state = \$\d+/);
      expect(pq.params).toContain('done');
    });

    it('builds a time-bucketed query', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count' }],
          time_dimension: { field: 'created_at', granularity: 'week' },
        },
        ORG_ID,
      );

      expect(pq.text).toContain("date_trunc('week', created_at)");
      expect(pq.text).toContain('time_bucket');
    });

    it('rejects unknown data source', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      expect(() =>
        buildQuery(
          'nonexistent',
          'fake',
          {
            measures: [{ field: 'id', agg: 'count' }],
          },
          ORG_ID,
        ),
      ).toThrow('Unknown data source');
    });

    it('rejects SQL injection in identifiers', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      expect(() =>
        buildQuery(
          'bam',
          'tasks',
          {
            measures: [{ field: 'id; DROP TABLE tasks', agg: 'count' }],
          },
          ORG_ID,
        ),
      ).toThrow('Invalid identifier');
    });

    it('applies sort ordering', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count', alias: 'task_count' }],
          dimensions: [{ field: 'priority' }],
          sort: [{ field: 'task_count', dir: 'desc' }],
        },
        ORG_ID,
      );

      expect(pq.text).toContain('ORDER BY task_count DESC');
    });

    it('applies limit', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count' }],
          limit: 25,
        },
        ORG_ID,
      );

      expect(pq.text).toContain('LIMIT 25');
    });

    it('caps limit at 10000', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bam',
        'tasks',
        {
          measures: [{ field: 'id', agg: 'count' }],
          limit: 50000,
        },
        ORG_ID,
      );

      expect(pq.text).toContain('LIMIT 10000');
    });

    it('isolates tenants on organization_id for organization_id-scoped sources', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      // bond:deals is a canonical organization_id-default source. (bam:tasks was
      // previously used here but it correctly scopes on org_id now — see the
      // orgColumn fix in data-source-registry.ts — so it would fail this case.)
      const pq = buildQuery(
        'bond',
        'deals',
        { measures: [{ field: 'id', agg: 'count' }] },
        ORG_ID,
      );

      expect(pq.text).toMatch(/WHERE organization_id = \$\d+/);
      expect(pq.params).toContain(ORG_ID);
    });

    it('isolates tenants on org_id for bureau (DEFECT A regression)', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bureau',
        'floor_analytics',
        { measures: [{ field: 'summon_count', agg: 'sum', alias: 'summons' }] },
        ORG_ID,
      );

      // Must scope on org_id, NOT organization_id (which does not exist on
      // bureau_floor_analytics and would 42703).
      expect(pq.text).toMatch(/WHERE org_id = \$\d+/);
      expect(pq.text).not.toContain('organization_id');
      expect(pq.params).toContain(ORG_ID);
    });

    it('applies date_range to the source temporal column without a time_dimension (DEFECT B regression)', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bureau',
        'floor_analytics',
        {
          measures: [{ field: 'summon_count', agg: 'sum', alias: 'summons' }],
          date_range: { preset: 'last_7_days' },
        },
        ORG_ID,
      );

      // bureau's temporal dimension is `day`; the range must be applied to it
      // even though no time_dimension was supplied.
      expect(pq.text).toMatch(/day >= \$\d+/);
      expect(pq.text).toMatch(/day <= \$\d+/);
    });

    it('resolves the last_1_days preset (DEFECT C regression)', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'bureau',
        'floor_analytics',
        {
          measures: [{ field: 'summon_count', agg: 'sum', alias: 'summons' }],
          date_range: { preset: 'last_1_days' },
        },
        ORG_ID,
      );

      // last_1_days previously resolved to null and dropped the filter entirely.
      expect(pq.text).toMatch(/day >= \$\d+/);
      expect(pq.text).toMatch(/day <= \$\d+/);
    });
  });

  // JSONB payload aggregation — the Blip enablement. blip/entries exposes
  // `payload` as a drillable JSONB column (jsonbColumns), so metrics and device
  // dimensions are reached by `path` with no dedicated columns.
  describe('JSONB path aggregation', () => {
    it('groups a JSONB dimension via a parameterized #>> path', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'blip',
        'entries',
        {
          measures: [{ field: 'id', agg: 'count', alias: 'reports' }],
          dimensions: [{ field: 'payload', path: ['device', 'device_model'], alias: 'device_model' }],
        },
        ORG_ID,
      );
      // Path is bound as a text[] parameter, never interpolated into SQL.
      expect(pq.text).toMatch(/\(payload #>> \$\d+::text\[\]\) AS device_model/);
      expect(pq.text).toContain('GROUP BY device_model');
      expect(pq.params).toContain('{"device","device_model"}');
      // org isolation still on org_id
      expect(pq.text).toMatch(/WHERE org_id = \$\d+/);
    });

    it('casts a JSONB measure to numeric for aggregation', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'blip',
        'entries',
        { measures: [{ field: 'payload', path: ['metrics', 'fps'], agg: 'avg', alias: 'avg_fps' }] },
        ORG_ID,
      );
      expect(pq.text).toMatch(/AVG\(\(payload #>> \$\d+::text\[\]\)::numeric\) AS avg_fps/);
      expect(pq.params).toContain('{"metrics","fps"}');
    });

    it('emits percentile_cont for p95 latency', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'blip',
        'entries',
        {
          measures: [
            { field: 'payload', path: ['metrics', 'total_processing_ms'], agg: 'p95', alias: 'p95_ms' },
          ],
          dimensions: [{ field: 'payload', path: ['device', 'device_model'], alias: 'device_model' }],
        },
        ORG_ID,
      );
      expect(pq.text).toMatch(
        /percentile_cont\(0\.95\) WITHIN GROUP \(ORDER BY \(payload #>> \$\d+::text\[\]\)::numeric\) AS p95_ms/,
      );
    });

    it('numeric-casts a JSONB comparison filter and parameterizes the value', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'blip',
        'entries',
        {
          measures: [{ field: 'id', agg: 'count' }],
          filters: [{ field: 'payload', path: ['metrics', 'frame_time_ms'], op: 'gt', value: 33 }],
        },
        ORG_ID,
      );
      expect(pq.text).toMatch(/\(payload #>> \$\d+::text\[\]\)::numeric > \$\d+/);
      expect(pq.params).toContain('33');
    });

    it('rejects a JSONB path on a column not allow-listed as jsonb', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      // bam/tasks declares no jsonbColumns, so any path is refused.
      expect(() =>
        buildQuery(
          'bam',
          'tasks',
          { measures: [{ field: 'title', path: ['a', 'b'], agg: 'count' }] },
          ORG_ID,
        ),
      ).toThrow('JSONB path not allowed');
    });

    it('folds NULL/empty JSONB dimension values into a labeled bucket', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const pq = buildQuery(
        'blip',
        'entries',
        {
          measures: [{ field: 'id', agg: 'count', alias: 'reports' }],
          dimensions: [
            { field: 'payload', path: ['device', 'device_model'], alias: 'device_model', null_label: 'Unknown device' },
          ],
        },
        ORG_ID,
      );
      // Older payloads with no device_model become an explicit "Unknown device"
      // group rather than a blank bar.
      expect(pq.text).toMatch(/COALESCE\(NULLIF\(\(payload #>> \$\d+::text\[\]\)::text, ''\), \$\d+\) AS device_model/);
      expect(pq.text).toContain('GROUP BY device_model');
      expect(pq.params).toContain('Unknown device');
    });

    it('keeps a malicious path segment inside the bound parameter, not the SQL', async () => {
      const { buildQuery } = await import('../src/services/query.service.js');
      const evil = "x'; DROP TABLE blip_entries;--";
      const pq = buildQuery(
        'blip',
        'entries',
        {
          measures: [{ field: 'id', agg: 'count' }],
          dimensions: [{ field: 'payload', path: [evil], alias: 'd' }],
        },
        ORG_ID,
      );
      // The SQL never contains the injected text; it lives only in a parameter.
      expect(pq.text).not.toContain('DROP TABLE');
      expect(pq.params.some((p) => p.includes('DROP TABLE'))).toBe(true);
    });
  });
});
