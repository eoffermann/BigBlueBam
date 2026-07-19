import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  // ESM only. The package is `"type": "module"` and every consumer imports the
  // ESM build (or runs the TS source via tsx) - nothing requires it as
  // CommonJS. A cjs build additionally emitted an empty-import-meta warning
  // because `import.meta.url` has no value in CommonJS, which collapsed the
  // PKG_DIR / REPO_ROOT path anchoring in cli.ts / runner.ts for any cjs
  // consumer. Dropping cjs removes the warning at the source.
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  splitting: false,
  sourcemap: true,
});
