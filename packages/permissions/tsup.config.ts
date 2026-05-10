import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/resolver.ts', 'src/generated/permissions.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ['fastify'],
});
