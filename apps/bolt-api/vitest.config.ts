import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@bigbluebam/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {

    // CI runners sometimes blow through the 5s default on first-test-in-file

    // import cost (drizzle + peer-app-stubs can take multiple seconds).

    testTimeout: 60_000,

    hookTimeout: 60_000,
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
