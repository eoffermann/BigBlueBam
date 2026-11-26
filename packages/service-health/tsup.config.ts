import { defineConfig } from 'tsup';

export default defineConfig({
  // internal-peer: the framework-free guard core for non-Fastify servers (mcp-server, #277).
  entry: ['src/index.ts', 'src/internal-peer.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ['fastify'],
});
