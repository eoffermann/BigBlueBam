import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    // testTimeout raised from the 5000ms default. See DECISIONS.md D-008d.
    testTimeout: 30000,
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
});
