import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/banter/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
      '@bigbluebam/ui/notifications-bell': resolve(__dirname, '../../packages/ui/notifications-bell.tsx'),
      '@bigbluebam/ui/help-center': resolve(__dirname, '../../packages/ui/help-center.tsx'),
      '@bigbluebam/ui/user-menu': resolve(__dirname, '../../packages/ui/user-menu.tsx'),
      '@bigbluebam/ui/help-viewer': resolve(__dirname, '../../packages/ui/help-viewer.tsx'),
      '@bigbluebam/ui/markdown': resolve(__dirname, '../../packages/ui/markdown.ts'),
    },
  },
  server: {
    port: 3002,
    proxy: {
      '/banter/api': {
        target: 'http://localhost:4002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/banter\/api/, ''),
      },
      '/banter/ws': {
        target: 'ws://localhost:4002',
        ws: true,
        rewrite: (path) => path.replace(/^\/banter\/ws/, '/ws'),
      },
    },
  },
});
