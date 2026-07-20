import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  // MUST be '/bursar/'. Without it Vite emits absolute '/assets/...' paths, every asset 404s
  // against the shared static-asset regex in the nginx configs, and the symptom presents as
  // an nginx bug rather than a build-config one.
  base: '/bursar/',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Every @bigbluebam/ui/* alias the sibling SPAs carry, copied wholesale rather than
    // cherry-picked. The frontend Dockerfile chains all 24 SPA builds with `&&`, so a single
    // unresolved alias here breaks the ENTIRE frontend image, not just Bursar. The one that
    // bites is @bigbluebam/ui/markdown, which nothing in this app imports directly -- it is
    // pulled in transitively by help-center.tsx and help-viewer.tsx. Rule is "copy them all".
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
      '@bigbluebam/ui/help-viewer': resolve(__dirname, '../../packages/ui/help-viewer.tsx'),
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
    // 3023. Burn holds 3022.
    port: 3023,
    proxy: {
      '/bursar/api': {
        target: 'http://localhost:4023',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bursar\/api/, ''),
      },
      '/bursar/ws': {
        target: 'ws://localhost:4023',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bursar\/ws/, '/ws'),
      },
    },
  },
});
