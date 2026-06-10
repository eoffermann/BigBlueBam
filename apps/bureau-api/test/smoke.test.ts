import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Placeholder smoke test — mirrors the shape of board-api/test/board.test.ts
// so the vitest runner has something to discover while workstream 2 builds
// out the real route + service test suite.
// ---------------------------------------------------------------------------

describe('bureau-api scaffold', () => {
  it('vitest is wired up', () => {
    expect(1 + 1).toBe(2);
  });
});
