import { defineConfig } from 'tsup';

export default defineConfig({
  // cli.ts: `node dist/cli.js restore-objects --from-backup` (spec 9.7 runbook).
  entry: ['src/server.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  splitting: true,
  dts: false,
});
