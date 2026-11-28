import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every dark-theme capture that exists under public/screenshots, as a public URL path.
 * ScreenshotFrame crossfades a light capture to its /dark/ twin on hover only when that twin
 * is in this list, so a frame never points its hover at a file that does not exist (#418).
 * Derived from disk at build time: adding or removing a capture needs no code change.
 */
function darkCaptures(): string[] {
  const base = resolve(__dirname, 'public');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push('/' + p.slice(base.length + 1).split('\\').join('/'));
    }
  };
  const shots = join(base, 'screenshots');
  if (existsSync(shots)) walk(shots);
  return out.filter((p) => p.includes('/dark/')).sort();
}

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  define: {
    __DARK_CAPTURES__: JSON.stringify(darkCaptures()),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 8090,
  },
});
