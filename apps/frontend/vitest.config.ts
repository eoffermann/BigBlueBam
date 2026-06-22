import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/shared': resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {

    // CI runners sometimes blow through the 5s default on first-test-in-file

    // import cost (drizzle + peer-app-stubs can take multiple seconds).

    testTimeout: 60_000,

    hookTimeout: 60_000,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
});
