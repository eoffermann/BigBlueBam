import { defineConfig } from 'tsup';

export default defineConfig({
  // The main barrel is browser-safe. Server-only modules are shipped as SEPARATE subpath
  // entries so they never land in a browser bundle (a barrel re-export would drag them into
  // every SPA build):
  //   - bulwark-arm-key.ts pulls in node:crypto, which breaks rollup in the SPAs.
  //   - visibility-client.ts reads INTERNAL_SERVICE_SECRET from process.env, which must
  //     never be shipped to a browser.
  // Every server-only module needs BOTH an entry here AND an `exports` block in
  // package.json. Omitting this entry means no dist artifact is emitted and consuming
  // services fail their image build with a module-resolution error.
  entry: ['src/index.ts', 'src/bulwark-arm-key.ts', 'src/visibility-client.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
