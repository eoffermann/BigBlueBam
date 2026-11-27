import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/fastify-request.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ['fastify', '@bigbluebam/shared'],
});
