import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/b3/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
      '@bigbluebam/ui/user-menu': resolve(__dirname, '../../packages/ui/user-menu.tsx'),
      '@bigbluebam/ui/help-viewer': resolve(__dirname, '../../packages/ui/help-viewer.tsx'),
      '@bigbluebam/ui/markdown': resolve(__dirname, '../../packages/ui/markdown.ts'),
      '@bigbluebam/ui/presence-chip-strip': resolve(__dirname, '../../packages/ui/presence-chip-strip.tsx'),
      '@bigbluebam/ui/incoming-call-overlay': resolve(__dirname, '../../packages/ui/incoming-call-overlay.tsx'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/b3/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/b3\/api/, ''),
      },
      '/b3/ws': {
        target: 'ws://localhost:4000',
        ws: true,
        rewrite: (path) => path.replace(/^\/b3\/ws/, '/ws'),
      },
    },
  },
});
