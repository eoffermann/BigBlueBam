import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@livekit/components-react',
    'livekit-client',
  ],
});
