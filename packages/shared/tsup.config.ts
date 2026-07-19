import { defineConfig } from 'tsup';

export default defineConfig({
  // The main barrel is browser-safe. bulwark-arm-key.ts is server-only (node:crypto) and is
  // shipped as a separate subpath entry so it never lands in the browser bundle (a barrel
  // re-export would drag node:crypto into every SPA build and break rollup).
  entry: ['src/index.ts', 'src/bulwark-arm-key.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
