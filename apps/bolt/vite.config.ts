import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/bolt/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
      '@bigbluebam/ui/user-menu': resolve(__dirname, '../../packages/ui/user-menu.tsx'),
      '@bigbluebam/ui/help-viewer': resolve(__dirname, '../../packages/ui/help-viewer.tsx'),
      '@bigbluebam/ui/markdown': resolve(__dirname, '../../packages/ui/markdown.ts'),
    },
  },
  server: {
    port: 3006,
    proxy: {
      '/bolt/api': {
        target: 'http://localhost:4006',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bolt\/api/, ''),
      },
    },
  },
});
