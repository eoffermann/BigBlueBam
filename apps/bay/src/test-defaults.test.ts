// #391: the shared SPA test setup (@bigbluebam/ui/test-setup, loaded by test/setup.ts) reaches
// the tests themselves. Bay sets no budget of its own, so these values can only come from there.
import { getConfig } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SPA_ASYNC_UTIL_TIMEOUT_MS, SPA_TEST_TIMEOUT_MS } from '@bigbluebam/ui/test-setup';

describe('shared SPA test defaults (#391)', () => {
  it('raises the Testing Library async wait above its 1 s default', () => {
    expect(getConfig().asyncUtilTimeout).toBe(SPA_ASYNC_UTIL_TIMEOUT_MS);
  });

  it('raises the per-test budget above the async wait (vitest defaults to 5 s)', ({ task }) => {
    expect(task.timeout).toBe(SPA_TEST_TIMEOUT_MS);
    expect(SPA_TEST_TIMEOUT_MS).toBeGreaterThan(SPA_ASYNC_UTIL_TIMEOUT_MS);
  });
});
