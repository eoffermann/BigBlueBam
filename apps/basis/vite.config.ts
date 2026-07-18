import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/basis/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
    },
  },
  server: {
    port: 3019,
    proxy: {
      '/basis/api': {
        target: 'http://localhost:4019',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/basis\/api/, ''),
      },
    },
  },
});
