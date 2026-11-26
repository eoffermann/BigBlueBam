import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  parseTaskRefs,
  verifyGithubSignature,
  generateWebhookSecret,
  decidePrTransition,
  extractHookEvents,
  buildPrEventRow,
} from '../src/services/github-integration.service.js';

describe('GitHub integration service', () => {
  describe('parseTaskRefs', () => {
    it('extracts a single task ref from a commit message', () => {
      expect(parseTaskRefs('MAGE-38: fix the thing')).toEqual(['MAGE-38']);
    });

    it('uppercases lowercase prefixes', () => {
      expect(parseTaskRefs('fixes mage-12 and mage-13')).toEqual(['MAGE-12', 'MAGE-13']);
    });

    it('deduplicates repeated refs', () => {
      expect(parseTaskRefs('MAGE-1 relates to MAGE-1 and MAGE-2')).toEqual(['MAGE-1', 'MAGE-2']);
    });

    it('handles multiple prefixes in the same text', () => {
      const refs = parseTaskRefs('Closes FOO-7; blocks BAR-99');
      expect(refs.sort()).toEqual(['BAR-99', 'FOO-7']);
    });

    it('returns an empty array for text without refs', () => {
      expect(parseTaskRefs('just a regular commit message')).toEqual([]);
    });

    it('returns empty for null/undefined input', () => {
      expect(parseTaskRefs(null)).toEqual([]);
      expect(parseTaskRefs(undefined)).toEqual([]);
      expect(parseTaskRefs('')).toEqual([]);
    });

    it('does not match prefixes shorter than 2 chars or longer than 10', () => {
      expect(parseTaskRefs('A-1 matches?')).toEqual([]);
      expect(parseTaskRefs('TOOMANYLETTERS-1 matches?')).toEqual([]);
    });

    it('ignores refs without digits', () => {
      expect(parseTaskRefs('MAGE-foo is not a ref')).toEqual([]);
    });
  });

  describe('verifyGithubSignature', () => {
    const secret = 'supersecretvalue';
    const body = JSON.stringify({ hello: 'world' });
    const validSig =
      'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

    it('accepts a valid signature', () => {
      expect(verifyGithubSignature(body, validSig, secret)).toBe(true);
    });

    it('accepts a valid signature with buffer body', () => {
      expect(verifyGithubSignature(Buffer.from(body, 'utf8'), validSig, secret)).toBe(true);
    });

    it('rejects a tampered body', () => {
      expect(verifyGithubSignature(body + 'x', validSig, secret)).toBe(false);
    });

    it('rejects a wrong secret', () => {
      expect(verifyGithubSignature(body, validSig, 'wrong-secret')).toBe(false);
    });

    it('rejects a missing signature header', () => {
      expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
    });

    it('rejects a signature without sha256= prefix', () => {
      const raw = createHmac('sha256', secret).update(body).digest('hex');
      expect(verifyGithubSignature(body, raw, secret)).toBe(false);
    });

    it('rejects a signature with wrong length', () => {
      expect(verifyGithubSignature(body, 'sha256=deadbeef', secret)).toBe(false);
    });
  });

  describe('decidePrTransition', () => {
    const fullConfig = {
      transition_on_pr_open_phase_id: 'phase-review',
      transition_on_pr_merged_phase_id: 'phase-done',
    };
    const emptyConfig = {
      transition_on_pr_open_phase_id: null,
      transition_on_pr_merged_phase_id: null,
    };

    it('returns the review phase when PR opened and config set', () => {
      expect(decidePrTransition('opened', false, fullConfig)).toBe('phase-review');
    });

    it('returns the done phase when PR merged and config set', () => {
      expect(decidePrTransition('closed', true, fullConfig)).toBe('phase-done');
    });

    it('returns null when PR opened but config is empty', () => {
      expect(decidePrTransition('opened', false, emptyConfig)).toBeNull();
    });

    it('returns null when PR closed-without-merge (merged=false)', () => {
      expect(decidePrTransition('closed', false, fullConfig)).toBeNull();
    });

    it('returns null for unrelated PR actions (edited, labeled, etc.)', () => {
      expect(decidePrTransition('edited', false, fullConfig)).toBeNull();
      expect(decidePrTransition('labeled', false, fullConfig)).toBeNull();
      expect(decidePrTransition('reopened', false, fullConfig)).toBeNull();
    });

    it('returns null when PR merged but only open transition is configured', () => {
      expect(
        decidePrTransition('closed', true, {
          transition_on_pr_open_phase_id: 'phase-review',
          transition_on_pr_merged_phase_id: null,
        }),
      ).toBeNull();
    });
  });

  describe('generateWebhookSecret', () => {
    it('returns 64 hex chars (32 bytes)', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns a new value on each call', () => {
      const a = generateWebhookSecret();
      const b = generateWebhookSecret();
      expect(a).not.toBe(b);
    });
  });

  describe('extractHookEvents (migration 0273)', () => {
    it('returns the sorted, de-duplicated hook.events', () => {
      expect(extractHookEvents({ hook: { events: ['push', 'pull_request', 'push'] } })).toEqual([
        'pull_request',
        'push',
      ]);
    });

    it('returns null (unknown) when the list is absent, empty or not an array', () => {
      expect(extractHookEvents({})).toBeNull();
      expect(extractHookEvents(null)).toBeNull();
      expect(extractHookEvents({ hook: { events: [] } })).toBeNull();
      expect(extractHookEvents({ hook: { events: 'push' } })).toBeNull();
      expect(extractHookEvents({ hook: { events: [1, null] } })).toBeNull();
    });
  });

  describe('buildPrEventRow (migration 0273)', () => {
    const ctx = {
      org_id: 'org',
      integration_id: 'int',
      project_id: 'proj',
      repo_owner: 'skipper',
      repo_name: 'radio',
      delivery_id: 'd-1',
      now: new Date('2026-11-26T00:00:00Z'),
    };

    it('ignores other events and payloads without a PR number', () => {
      expect(buildPrEventRow('push', { pull_request: { number: 1 } }, ctx)).toBeNull();
      expect(buildPrEventRow('pull_request', { pull_request: {} }, ctx)).toBeNull();
    });

    it('parses task refs from the title and body even when none match a task', () => {
      const row = buildPrEventRow(
        'pull_request',
        { action: 'opened', pull_request: { number: 3, title: 'MAGE-38 fix', body: 'see isle-4' } },
        ctx,
      );
      expect(row?.task_refs.sort()).toEqual(['ISLE-4', 'MAGE-38']);
      expect(row?.merged).toBe(false);
      expect(row?.merged_at).toBeNull();
      expect(row?.occurred_at).toEqual(ctx.now);
    });

    it('uses merged_at as occurred_at for a merge, and the review time for a review', () => {
      const merge = buildPrEventRow(
        'pull_request',
        { action: 'closed', pull_request: { number: 3, merged: true, merged_at: '2026-11-20T10:00:00Z' } },
        ctx,
      );
      expect(merge?.occurred_at.toISOString()).toBe('2026-11-20T10:00:00.000Z');
      const review = buildPrEventRow(
        'pull_request_review',
        {
          action: 'submitted',
          pull_request: { number: 3 },
          review: { id: 5, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-19T08:00:00Z' },
        },
        ctx,
      );
      expect(review?.review_state).toBe('changes_requested');
      expect(review?.occurred_at.toISOString()).toBe('2026-11-19T08:00:00.000Z');
    });
  });
});
