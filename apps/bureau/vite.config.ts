import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/bureau/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
      '@bigbluebam/ui/org-switcher': resolve(__dirname, '../../packages/ui/org-switcher.tsx'),
      '@bigbluebam/ui/notifications-bell': resolve(__dirname, '../../packages/ui/notifications-bell.tsx'),
      '@bigbluebam/ui/help-center': resolve(__dirname, '../../packages/ui/help-center.tsx'),
      '@bigbluebam/ui/user-menu': resolve(__dirname, '../../packages/ui/user-menu.tsx'),
      '@bigbluebam/ui/sidebar-footer': resolve(__dirname, '../../packages/ui/sidebar-footer.tsx'),
      '@bigbluebam/ui/help-viewer': resolve(__dirname, '../../packages/ui/help-viewer.tsx'),
      '@bigbluebam/ui/permissions-context': resolve(__dirname, '../../packages/ui/permissions-context.tsx'),
      '@bigbluebam/ui/use-can': resolve(__dirname, '../../packages/ui/use-can.tsx'),
    },
  },
  server: {
    port: 3018,
    proxy: {
      '/bureau/api': {
        target: 'http://localhost:4015',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bureau\/api/, ''),
      },
      '/bureau/ws': {
        target: 'ws://localhost:4015',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bureau\/ws/, '/ws'),
      },
      // Bureau shares Bam's session — proxy auth/me calls in dev too.
      '/b3/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/b3\/api/, ''),
      },
    },
  },
});
