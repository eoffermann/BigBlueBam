import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/beacon/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
      '@bigbluebam/ui/notifications-bell': resolve(__dirname, '../../packages/ui/notifications-bell.tsx'),
      '@bigbluebam/ui/user-menu': resolve(__dirname, '../../packages/ui/user-menu.tsx'),
      '@bigbluebam/ui/sidebar-footer': resolve(__dirname, '../../packages/ui/sidebar-footer.tsx'),
      '@bigbluebam/ui/help-viewer': resolve(__dirname, '../../packages/ui/help-viewer.tsx'),
      '@bigbluebam/ui/markdown': resolve(__dirname, '../../packages/ui/markdown.ts'),
      '@bigbluebam/ui/presence-chip-strip': resolve(__dirname, '../../packages/ui/presence-chip-strip.tsx'),
      '@bigbluebam/ui/incoming-call-overlay': resolve(__dirname, '../../packages/ui/incoming-call-overlay.tsx'),
    },
  },
  server: {
    port: 3004,
    proxy: {
      '/beacon/api': {
        target: 'http://localhost:4004',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/beacon\/api/, ''),
      },
    },
  },
});
