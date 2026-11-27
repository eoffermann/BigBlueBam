import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bastionSearchHitSchema, bastionSearchQuerySchema } from '@bigbluebam/shared';
import { SEARCH_URLS, queryWords, scoreMatch } from '../src/services/search.service.js';

// M10: GET /search (spec 5.1 row 95, 8.5), read by the platform search_everything.

describe('Bastion search scoring', () => {
  it('splits the query into lower-case words of two or more letters and digits', () => {
    expect(queryWords('Laptop  ENCRYPTION, 2-step!')).toEqual(['laptop', 'encryption', 'step']);
    expect(queryWords('a ; %')).toEqual([]);
  });

  it('ranks the whole phrase in the title above partial and summary-only matches', () => {
    const exact = scoreMatch('laptop encryption', 'Laptop encryption');
    const phrase = scoreMatch('laptop encryption', 'Laptop encryption is on');
    const partial = scoreMatch('laptop encryption', 'Laptops are managed');
    const summaryOnly = scoreMatch('encryption', 'Device management', 'Disks use full-disk encryption');
    expect(exact).toBe(1);
    expect(phrase).toBe(0.95);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(phrase);
    expect(summaryOnly).toBeGreaterThan(0);
    expect(summaryOnly).toBeLessThan(partial + 0.01);
  });

  it('scores 0 (dropped) when nothing matches, and never above 1', () => {
    expect(scoreMatch('coconut', 'Code review before merge', 'Two people look at every change')).toBe(0);
    for (const [q, t, s] of [
      ['code review', 'Code review', ''],
      ['review code review', 'code review code', 'review'],
    ] as const) {
      const v = scoreMatch(q, t, s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('links a control to its detail page and a policy to the Policies page', () => {
    expect(SEARCH_URLS.control('22222222-2222-4222-8222-222222222222')).toBe('/bastion/controls/22222222-2222-4222-8222-222222222222');
    expect(SEARCH_URLS.policy()).toBe('/bastion/policies');
  });
});

describe('Bastion search contract', () => {
  it('needs a query of at least two characters and caps the limit at 50', () => {
    expect(bastionSearchQuerySchema.safeParse({ q: 'x' }).success).toBe(false);
    expect(bastionSearchQuerySchema.safeParse({ q: 'mfa', limit: '51' }).success).toBe(false);
    expect(bastionSearchQuerySchema.parse({ q: ' mfa ' })).toEqual({ q: 'mfa', limit: 20 });
    expect(bastionSearchQuerySchema.safeParse({ q: 'mfa', extra: '1' }).success).toBe(false);
  });

  it('hits carry the can_access entity type so search_everything can gate them', () => {
    const hit = {
      entity_type: 'bastion.control',
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Laptop encryption',
      snippet: '',
      score: 1,
      url: '/bastion/controls/22222222-2222-4222-8222-222222222222',
    };
    expect(bastionSearchHitSchema.parse(hit)).toEqual(hit);
    expect(bastionSearchHitSchema.safeParse({ ...hit, entity_type: 'bastion.evidence' }).success).toBe(false);
  });

  it('the route reads controls with control.read and adds policies only with policy.read (caller and asker)', () => {
    const src = readFileSync(join(__dirname, '../src/routes/search.routes.ts'), 'utf8');
    expect(src).toMatch(/fastify\.get\('\/search', \{ preHandler: \[requireAuth, can\('bastion\.control\.read'\), asker\('bastion\.control\.read'\)\] \}/);
    expect(src).toContain("fastify.bastionCan(request, 'bastion.policy.read')");
    const svc = readFileSync(join(__dirname, '../src/services/search.service.ts'), 'utf8');
    // The LIKE pattern is bound, never interpolated; the tsquery terms come from the M8 sanitizer.
    expect(svc).toMatch(/ILIKE \$2/);
    expect(svc).toContain('tsQueryTerms(query.q)');
    expect(svc).toContain("c.organization_id = $1 AND c.lifecycle = 'active'");
  });
});
