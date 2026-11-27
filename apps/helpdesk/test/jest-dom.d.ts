// jest-dom's own `@testing-library/jest-dom/vitest` augmentation resolves 'vitest' from its
// location in the pnpm store, which is not the 'vitest' this app resolves, so the matchers
// (toBeInTheDocument, ...) never reach this app's Assertion type under tsc (#355). Augment the
// app's own 'vitest' here; the runtime registration stays in test/setup.ts.
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors jest-dom's own declaration
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  // biome-ignore lint/suspicious/noExplicitAny: mirrors jest-dom's own declaration
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
