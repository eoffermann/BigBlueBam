import { describe, expect, it } from 'vitest';
import {
  appDisplayName,
  formatLocationDisplay,
  humanizeLocationTitle,
} from './format-location.js';

// Pins the "no resource locators in the UI" contract for the docked box's
// Viewing:/In: rows — UUIDs, u<hex> surface ids, and raw paths never reach
// the user; app ids render as product names.

describe('appDisplayName', () => {
  it('maps suite app ids to product names', () => {
    expect(appDisplayName('b3')).toBe('Bam');
    expect(appDisplayName('brief')).toBe('Brief');
    expect(appDisplayName('helpdesk')).toBe('Helpdesk');
  });
  it('capitalizes unknown apps instead of leaking raw ids', () => {
    expect(appDisplayName('frndo')).toBe('Frndo');
  });
});

describe('humanizeLocationTitle', () => {
  it('passes a clean host label through', () => {
    expect(humanizeLocationTitle('Frndo Board', '/b3/projects/x/board', 'b3')).toBe(
      'Frndo Board',
    );
  });

  it('strips UUIDs embedded in labels', () => {
    expect(
      humanizeLocationTitle(
        'Task 3a7c2c1e-0000-4000-8000-000000000000',
        null,
        'b3',
      ),
    ).toBe('Task');
  });

  it('strips url-surface ids (u + 16 hex)', () => {
    expect(humanizeLocationTitle('Room u1234567890abcdef', null, 'url')).toBe('Room');
  });

  it('falls back to a path breadcrumb without ids or the app prefix', () => {
    expect(
      humanizeLocationTitle(
        null,
        '/b3/projects/3a7c2c1e-0000-4000-8000-000000000000/dashboard',
        'b3',
      ),
    ).toBe('Projects › Dashboard');
  });

  it('treats a path-shaped label as a path, not a title', () => {
    expect(humanizeLocationTitle('/brief/documents/launch-plan', null, 'brief')).toBe(
      'Documents › Launch Plan',
    );
  });

  it('returns empty when nothing presentable remains', () => {
    expect(
      humanizeLocationTitle('3a7c2c1e-0000-4000-8000-000000000000', null, 'b3'),
    ).toBe('');
  });
});

describe('formatLocationDisplay', () => {
  it('renders [App] Title', () => {
    expect(formatLocationDisplay('b3', 'Frndo Board', '/b3/board')).toBe('[Bam] Frndo Board');
  });
  it('renders just [App] when no title survives cleaning', () => {
    expect(
      formatLocationDisplay('brief', null, '/brief/3a7c2c1e-0000-4000-8000-000000000000'),
    ).toBe('[Brief]');
  });
});
