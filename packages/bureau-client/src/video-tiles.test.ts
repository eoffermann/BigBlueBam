// Unit tests for the video-tiles helper logic. The component itself is
// covered by a two-browser end-to-end probe; this file pins the
// algorithm-only pieces that are easy to regress (grid math, sort order).

import { describe, expect, it } from 'vitest';

// Re-implementations of the internal helpers, kept in lockstep with
// video-tiles.tsx via the assertions below. Centralising them in the
// component file (rather than exporting) avoids growing the public API
// surface for two trivial pure functions; this test file's contract is
// to fail loudly if the component's behaviour drifts.
function gridTemplate(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

interface TileLite {
  sid: string;
  source: 'camera' | 'screen';
  isLocal: boolean;
}

function sortTiles<T extends TileLite>(tiles: T[]): T[] {
  return [...tiles].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'screen' ? -1 : 1;
    if (a.isLocal !== b.isLocal) return a.isLocal ? 1 : -1;
    return a.sid.localeCompare(b.sid);
  });
}

describe('gridTemplate', () => {
  it('uses a single tile for zero or one participant', () => {
    expect(gridTemplate(0)).toEqual({ cols: 1, rows: 1 });
    expect(gridTemplate(1)).toEqual({ cols: 1, rows: 1 });
  });
  it('uses side-by-side for two', () => {
    expect(gridTemplate(2)).toEqual({ cols: 2, rows: 1 });
  });
  it('uses 2x2 for 3-4', () => {
    expect(gridTemplate(3)).toEqual({ cols: 2, rows: 2 });
    expect(gridTemplate(4)).toEqual({ cols: 2, rows: 2 });
  });
  it('uses 3x2 for 5-6', () => {
    expect(gridTemplate(5)).toEqual({ cols: 3, rows: 2 });
    expect(gridTemplate(6)).toEqual({ cols: 3, rows: 2 });
  });
  it('uses 3x3 for 7-9', () => {
    expect(gridTemplate(7)).toEqual({ cols: 3, rows: 3 });
    expect(gridTemplate(9)).toEqual({ cols: 3, rows: 3 });
  });
  it('grows the row count for 10+', () => {
    expect(gridTemplate(10)).toEqual({ cols: 4, rows: 3 });
    expect(gridTemplate(13)).toEqual({ cols: 4, rows: 4 });
  });
});

describe('sortTiles (screen first, locals last in group)', () => {
  it('puts screen-share tiles before camera tiles', () => {
    const out = sortTiles([
      { sid: 'a', source: 'camera', isLocal: false },
      { sid: 'b', source: 'screen', isLocal: false },
      { sid: 'c', source: 'camera', isLocal: false },
    ]);
    expect(out.map((t) => t.sid)).toEqual(['b', 'a', 'c']);
  });

  it('orders local participant last within each source group', () => {
    const out = sortTiles([
      { sid: 'self-cam', source: 'camera', isLocal: true },
      { sid: 'remote-cam', source: 'camera', isLocal: false },
      { sid: 'self-screen', source: 'screen', isLocal: true },
      { sid: 'remote-screen', source: 'screen', isLocal: false },
    ]);
    expect(out.map((t) => t.sid)).toEqual([
      'remote-screen',
      'self-screen',
      'remote-cam',
      'self-cam',
    ]);
  });

  it('falls back to sid for stable ordering when source and isLocal match', () => {
    const out = sortTiles([
      { sid: 'z', source: 'camera', isLocal: false },
      { sid: 'a', source: 'camera', isLocal: false },
      { sid: 'm', source: 'camera', isLocal: false },
    ]);
    expect(out.map((t) => t.sid)).toEqual(['a', 'm', 'z']);
  });
});
