import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// findBy* / waitFor default to a 1 s budget. When the SPA suite runs alongside other packages
// the first render of a page (React Query fetch, Suspense, PermissionsProvider) can take several
// seconds, so a correct page failed with "Unable to find ..." (#384). Give every async wait the
// same generous budget; it only bounds how long a wait may take, so what each test asserts is
// unchanged. Stays well under the 60 s testTimeout in vitest.config.ts.
configure({ asyncUtilTimeout: 20_000 });

// Fail any test that lets a React update land outside act() (#224). Such a warning means a
// refetch or state update settled after the test asserted, the ordering-dependent pattern that
// turns into intermittent false-red CI under load. Tests wait with Testing Library's waitFor /
// findBy* (which wrap polling in act) and for the post-mutation refetch to settle.

const actWarnings: string[] = [];
const originalError = console.error.bind(console);
let spy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  actWarnings.length = 0;
  spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    if (/not wrapped in act\(/.test(text)) actWarnings.push(text.split('\n')[0] ?? text);
    originalError(...args);
  });
});

afterEach(() => {
  spy?.mockRestore();
  spy = null;
  if (actWarnings.length > 0) {
    const found = [...actWarnings];
    actWarnings.length = 0;
    throw new Error(`React updates landed outside act() (#224); wait for the settled state instead:\n${found.join('\n')}`);
  }
});
