import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  // MUST be '/bastion/'. Without it Vite emits absolute '/assets/...' paths and every asset
  // 404s against the shared static-asset regex in the nginx configs.
  base: '/bastion/',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Every @bigbluebam/ui/* alias the sibling SPAs carry, copied wholesale from apps/bursar.
    // The frontend Dockerfile chains every SPA build with `&&`, so one unresolved alias breaks
    // the ENTIRE frontend image. @bigbluebam/ui/markdown is pulled in transitively by
    // help-center.tsx even though nothing here imports it directly.
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bigbluebam/ui/launchpad': resolve(__dirname, '../../packages/ui/launchpad.tsx'),
      '@bigbluebam/ui/org-switcher': resolve(__dirname, '../../packages/ui/org-switcher.tsx'),
      '@bigbluebam/ui/notifications-bell': resolve(
        __dirname,
        '../../packages/ui/notifications-bell.tsx',
      ),
      '@bigbluebam/ui/help-center': resolve(__dirname, '../../packages/ui/help-center.tsx'),
      '@bigbluebam/ui/user-menu': resolve(__dirname, '../../packages/ui/user-menu.tsx'),
      '@bigbluebam/ui/sidebar-footer': resolve(__dirname, '../../packages/ui/sidebar-footer.tsx'),
      '@bigbluebam/ui/markdown': resolve(__dirname, '../../packages/ui/markdown.ts'),
      '@bigbluebam/ui/presence-chip-strip': resolve(
        __dirname,
        '../../packages/ui/presence-chip-strip.tsx',
      ),
      '@bigbluebam/ui/impersonation-banner': resolve(
        __dirname,
        '../../packages/ui/impersonation-banner.tsx',
      ),
      '@bigbluebam/ui/permissions-context': resolve(
        __dirname,
        '../../packages/ui/permissions-context.tsx',
      ),
      '@bigbluebam/ui/use-can': resolve(__dirname, '../../packages/ui/use-can.tsx'),
    },
  },
  server: {
    // 3024. Bursar holds 3023.
    port: 3024,
    proxy: {
      '/bastion/api': {
        target: 'http://localhost:4024',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bastion\/api/, ''),
      },
    },
  },
});
