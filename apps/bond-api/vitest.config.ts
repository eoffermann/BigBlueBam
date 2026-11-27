import { defineConfig } from 'vitest/config';

// Root-level options only. The test projects (unit + db, with their timeouts) are defined in
// vitest.workspace.ts through the workspace DB-test policy (#385).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
