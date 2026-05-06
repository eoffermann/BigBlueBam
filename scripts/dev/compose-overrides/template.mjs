// Per-service template generator for docker-compose.override.yml.
//
// Reads apps/<service>/package.json to discover:
//   - workspace dependencies (any "@bigbluebam/*" key in `dependencies`)
//   - entry filename (parsed from `start` script, fallback to "server.js")
//
// Returns the JS object representation of the compose service block.
// yaml.mjs emits it to YAML.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Classify a service for the compose-overrides CLI.
 * Returns { kind, reason? } where kind is one of:
 *   'node'           — supported, tsup→node pattern
 *   'vite-frontend'  — supported via the vite build --watch sidecar pattern
 *                      (Level 1). A future Level 2 dev-server mode can attach
 *                      as a sibling routing path; this kind name stays stable.
 *   'python'         — refused, planned via uvicorn --reload track
 *   'unknown'        — service not found in apps/
 */
export function classifyService(serviceName, repoRoot) {
  const appDir = path.join(repoRoot, 'apps', serviceName);
  const pkgPath = path.join(appDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    // Special case: voice-agent has no package.json (Python service)
    if (fs.existsSync(appDir) && fs.existsSync(path.join(appDir, 'requirements.txt'))) {
      return { kind: 'python' };
    }
    return { kind: 'unknown' };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { kind: 'unknown', reason: 'package.json failed to parse' };
  }

  const scripts = pkg.scripts || {};
  if (scripts.dev === 'vite' || scripts.dev?.startsWith('vite ')) {
    return { kind: 'vite-frontend' };
  }
  if (scripts.build === 'tsup' && /^node dist\/[\w.-]+\.js$/.test(scripts.start || '')) {
    return { kind: 'node' };
  }
  return { kind: 'unknown', reason: 'package.json does not match the supported tsup→node pattern' };
}

/**
 * List every service the CLI can address, classified.
 * Returns [{ name, kind }, ...] for every directory under apps/.
 */
export function listAllServices(repoRoot) {
  const appsDir = path.join(repoRoot, 'apps');
  if (!fs.existsSync(appsDir)) return [];
  const entries = fs.readdirSync(appsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, ...classifyService(e.name, repoRoot) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover workspace dependencies for a service.
 * Returns array of bare package names (e.g. ['shared', 'logging']) without
 * the @bigbluebam/ prefix.
 */
function discoverWorkspaceDeps(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.keys(deps)
    .filter((k) => k.startsWith('@bigbluebam/'))
    .map((k) => k.slice('@bigbluebam/'.length))
    .filter((name) => name !== pkg.name?.replace('@bigbluebam/', ''))
    .sort();
}

/**
 * Parse the entry filename from a `start` script like "node dist/server.js".
 * Returns "server" or "worker" etc. Falls back to "server" if unparseable.
 */
function parseEntryName(startScript) {
  if (!startScript) return 'server';
  const m = startScript.match(/^node dist\/([\w-]+)\.js$/);
  return m ? m[1] : 'server';
}

/**
 * Generate the service block for a Node tsup→node service.
 * Caller has already classified as 'node'.
 */
export function generateNodeServiceBlock(serviceName, repoRoot) {
  const pkgPath = path.join(repoRoot, 'apps', serviceName, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const workspaceDeps = discoverWorkspaceDeps(pkg);
  const entry = parseEntryName(pkg.scripts?.start);

  // Volumes: app source + config files, plus each workspace package's source
  // and its tsup config (read-only — config files don't change at runtime).
  const volumes = [
    `./apps/${serviceName}/src:/app/apps/${serviceName}/src`,
    `./apps/${serviceName}/tsconfig.json:/app/apps/${serviceName}/tsconfig.json:ro`,
    `./apps/${serviceName}/tsup.config.ts:/app/apps/${serviceName}/tsup.config.ts:ro`,
    `./tsconfig.base.json:/app/tsconfig.base.json:ro`,
  ];
  for (const dep of workspaceDeps) {
    volumes.push(`./packages/${dep}/src:/app/packages/${dep}/src`);
    const depTsupConfig = path.join(repoRoot, 'packages', dep, 'tsup.config.ts');
    if (fs.existsSync(depTsupConfig)) {
      volumes.push(`./packages/${dep}/tsup.config.ts:/app/packages/${dep}/tsup.config.ts:ro`);
    }
  }

  // Command: initial workspace + app build, then concurrent watchers, then
  // node --watch as the foreground process. exec so node becomes PID 1 and
  // signals propagate cleanly on `docker compose stop`.
  const commandLines = ['set -e', 'echo "[dev-watch] initial workspace build..."'];
  for (const dep of workspaceDeps) {
    commandLines.push(`pnpm --filter @bigbluebam/${dep} build`);
  }
  commandLines.push(`pnpm --filter @bigbluebam/${serviceName} build`);
  commandLines.push('echo "[dev-watch] starting watchers..."');
  for (const dep of workspaceDeps) {
    commandLines.push(`pnpm --filter @bigbluebam/${dep} dev &`);
  }
  commandLines.push(`pnpm --filter @bigbluebam/${serviceName} build:watch &`);
  commandLines.push(`exec node --watch dist/${entry}.js`);

  return {
    build: {
      context: '.',
      dockerfile: `apps/${serviceName}/Dockerfile`,
      target: 'deps',
    },
    image: `bigbluebam-${serviceName}:dev`,
    working_dir: `/app/apps/${serviceName}`,
    environment: {
      NODE_ENV: 'development',
    },
    volumes,
    command: ['sh', '-c', commandLines.join('\n')],
  };
}

/**
 * Read the URL prefix a Vite SPA serves itself at, from its vite.config.ts
 * `base: '/<prefix>/'` field. Throws if the field can't be located. The base
 * is the canonical mapping from app folder to served path (e.g., apps/frontend
 * → /b3/, apps/banter → /banter/), so we re-read it instead of guessing.
 */
function readViteBase(serviceName, repoRoot) {
  const cfgPath = path.join(repoRoot, 'apps', serviceName, 'vite.config.ts');
  const text = fs.readFileSync(cfgPath, 'utf8');
  const m = text.match(/\bbase:\s*['"]\/([^'"]+)\/['"]/);
  if (!m) {
    throw new Error(
      `compose-overrides: could not parse \`base:\` from apps/${serviceName}/vite.config.ts ` +
      `(expected something like \`base: '/${serviceName}/',\`).`,
    );
  }
  return m[1];
}

/**
 * Generate the dev-builder sidecar block for a Vite SPA. Runs
 * `vite build --watch` against bind-mounted source, emitting to
 * `apps/<service>/dist/` which the gateway nginx then serves.
 *
 * Caller has already classified as 'vite-frontend'.
 */
export function generateViteFrontendDevBuilder(serviceName, repoRoot) {
  // Defensive existence check on key source files. If any is missing the SPA
  // layout is unusual — fail loud rather than emit a half-broken block.
  const required = ['src', 'index.html', 'vite.config.ts', 'tsconfig.json'];
  for (const f of required) {
    if (!fs.existsSync(path.join(repoRoot, 'apps', serviceName, f))) {
      throw new Error(
        `compose-overrides: apps/${serviceName}/${f} not found; SPA layout differs from expected.`,
      );
    }
  }
  const hasPublic = fs.existsSync(path.join(repoRoot, 'apps', serviceName, 'public'));
  const hasTsconfigNode = fs.existsSync(path.join(repoRoot, 'apps', serviceName, 'tsconfig.node.json'));

  // packages/ui's source files are bind-mounted INDIVIDUALLY rather than as
  // a whole-directory mount. A whole-directory mount would shadow the
  // workspace image's preinstalled `packages/ui/node_modules` (which holds
  // peer deps like @tanstack/react-query that vite needs to resolve when
  // bundling ui imports — pnpm puts peer deps in the consumer's scope).
  const uiFiles = fs.readdirSync(path.join(repoRoot, 'packages/ui'))
    .filter((f) => /\.(tsx?|json)$/.test(f) && !f.startsWith('.'));

  const volumes = [
    `./apps/${serviceName}/src:/app/apps/${serviceName}/src`,
    `./apps/${serviceName}/index.html:/app/apps/${serviceName}/index.html`,
    `./apps/${serviceName}/vite.config.ts:/app/apps/${serviceName}/vite.config.ts:ro`,
    `./apps/${serviceName}/tsconfig.json:/app/apps/${serviceName}/tsconfig.json:ro`,
    `./apps/${serviceName}/dist:/app/apps/${serviceName}/dist`,
    `./packages/shared/src:/app/packages/shared/src`,
    ...uiFiles.map((f) => `./packages/ui/${f}:/app/packages/ui/${f}:ro`),
    `./tsconfig.base.json:/app/tsconfig.base.json:ro`,
    // Mask bind-mount with the testrunner image's installed node_modules.
    // packages/ui/node_modules is preserved naturally (no parent bind mount).
    `/app/node_modules`,
    `/app/apps/${serviceName}/node_modules`,
    `/app/packages/shared/node_modules`,
  ];
  if (hasPublic) {
    volumes.splice(1, 0, `./apps/${serviceName}/public:/app/apps/${serviceName}/public`);
  }
  if (hasTsconfigNode) {
    volumes.splice(volumes.indexOf(`./apps/${serviceName}/tsconfig.json:/app/apps/${serviceName}/tsconfig.json:ro`) + 1, 0,
      `./apps/${serviceName}/tsconfig.node.json:/app/apps/${serviceName}/tsconfig.node.json:ro`);
  }

  const command = [
    'set -e',
    `echo "[dev-watch] ${serviceName}: workspace deps + initial build..."`,
    'pnpm --filter @bigbluebam/shared build',
    `echo "[dev-watch] ${serviceName}: starting vite build --watch..."`,
    `exec pnpm --filter @bigbluebam/${serviceName} exec vite build --watch`,
  ].join('\n');

  return {
    build: {
      context: '.',
      dockerfile: 'infra/workspace/Dockerfile',
    },
    image: 'bigbluebam-workspace',
    working_dir: `/app/apps/${serviceName}`,
    environment: {
      NODE_ENV: 'development',
    },
    volumes,
    command: ['sh', '-c', command],
  };
}

/**
 * Generate the gateway-`frontend`-service overlay that mounts the listed SPAs'
 * dist directories over the baked-in serving paths. Compose merges this
 * service's `volumes:` list onto the base service's, so existing mounts
 * (nginx config, certs, docs) stay intact.
 */
export function generateFrontendOverlayForVite(serviceNames, repoRoot) {
  const sorted = [...serviceNames].sort();
  const volumes = sorted.map((name) => {
    const base = readViteBase(name, repoRoot);
    return `./apps/${name}/dist:/usr/share/nginx/html/${base}:ro`;
  });
  return { volumes };
}
