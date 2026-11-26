#!/usr/bin/env node
/**
 * gen-railway-configs.mjs
 *
 * Generates `railway/<service>.json` files from the authoritative service
 * catalog in scripts/deploy/shared/services.mjs. Each file is a standalone
 * Railway config-as-code manifest that the user points a Railway service at
 * via the dashboard's "Config Path" setting.
 *
 * Usage:
 *   node scripts/gen-railway-configs.mjs
 *
 * Re-run whenever services.mjs changes. Output is checked in.
 *
 * Why this layout (config-as-code under railway/ at the repo root):
 *
 *   Our Dockerfiles expect the MONOREPO ROOT as the build context — they do
 *   `COPY apps/api/package.json`, `COPY packages/shared/src`, etc. Railway's
 *   per-service "Root Directory" setting doubles as the build context, so if
 *   we set Root Directory to `apps/api` the build breaks. Instead we leave
 *   Root Directory at the repo root for every service and point each
 *   service's "Config Path" at its own file under `railway/`. The dockerfile
 *   path inside each railway.json is then relative to the repo root
 *   (`apps/api/Dockerfile`), which matches docker-compose.yml exactly.
 *
 * Watch patterns per service mean Railway only rebuilds when files that
 * actually affect that service change — essential for a 22-service monorepo.
 */
import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_SERVICES,
  INFRA_SERVICES,
  JOB_SERVICES,
} from './deploy/shared/services.mjs';
import { hintFor } from './deploy/shared/env-hints.mjs';
import { transformNginxForRailway } from './lib/railway-nginx.mjs';
import { dockerfileCopiedDirs, watchPatternForDir } from './lib/railway-watch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'railway');

// ─── Watch patterns ───────────────────────────────────────────────────
//
// A service is rebuilt when any matched file changes. We include the
// service's own source tree, its Dockerfile, the shared schema package
// (everything depends on it), the root lockfile, and the root package.json,
// plus (issue #170) every packages/<name> and apps/<name> directory the
// service's Dockerfile COPYs, read from the Dockerfile itself so a package
// the image builds can never be missing from its watch list.
// scripts/lib/railway-watch.test.mjs fails when the committed output drifts.

function watchPatternsFor(service) {
  if (!service.dockerfile) return undefined;
  const appDir = service.dockerfile.replace(/\/Dockerfile$/, '');
  const base = [
    `${appDir}/**`,
    'packages/shared/**',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'tsconfig.base.json',
    service.dockerfile,
  ];
  const dockerfileText = readFileSync(join(ROOT, service.dockerfile), 'utf8');
  for (const dir of dockerfileCopiedDirs(dockerfileText)) base.push(watchPatternForDir(dir));
  if (service.extra_watch_patterns) {
    base.push(...service.extra_watch_patterns);
  }
  return [...new Set(base)];
}

// ─── Config builders ──────────────────────────────────────────────────

function buildAppConfig(service) {
  const config = {
    $schema: 'https://railway.com/railway.schema.json',
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: service.dockerfile,
    },
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
  };

  const watch = watchPatternsFor(service);
  if (watch) config.build.watchPatterns = watch;
  if (service.build_args) config.build.buildArgs = service.build_args;

  if (service.start_command) {
    config.deploy.startCommand = service.start_command;
  }
  if (service.healthcheck) {
    config.deploy.healthcheckPath = service.healthcheck;
    config.deploy.healthcheckTimeout = 100;
  }
  return config;
}

function buildInfraConfig(service) {
  // Self-hosted infra services use a tiny passthrough Dockerfile under
  // infra/railway/<name>/Dockerfile so we can keep the same config-as-code
  // pattern for everything (single uniform path on Railway).
  return {
    $schema: 'https://railway.com/railway.schema.json',
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: service.dockerfile,
      watchPatterns: [service.dockerfile],
    },
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
  };
}

function buildJobConfig(service) {
  // One-shot jobs (migrate) — no healthcheck, no restart. The migrate job
  // bakes infra/postgres/migrations/ into the api image, so a new SQL file
  // there must trigger a rebuild even though apps/api/** didn't change.
  const watch = watchPatternsFor(service) ?? [];
  if (service.name === 'migrate') {
    watch.push('infra/postgres/migrations/**');
  }
  return {
    $schema: 'https://railway.com/railway.schema.json',
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: service.dockerfile,
      watchPatterns: watch,
    },
    deploy: {
      startCommand: service.start_command,
      restartPolicyType: 'NEVER',
    },
  };
}

// ─── Write ────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

// Wipe existing files in OUT_DIR (not subdirs) so renames/removals are
// reflected. We do NOT recurse, so a `.gitkeep` or README stays put.
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith('.json')) unlinkSync(join(OUT_DIR, f));
}

let written = 0;
const manifests = [];

for (const svc of APP_SERVICES) {
  const path = join(OUT_DIR, `${svc.name}.json`);
  writeFileSync(path, JSON.stringify(buildAppConfig(svc), null, 2) + '\n');
  manifests.push({ name: svc.name, kind: 'app', file: `railway/${svc.name}.json` });
  written++;
}

for (const svc of INFRA_SERVICES) {
  // Skip managed services (postgres, redis) — those are Railway plugins,
  // not container builds. The user adds them via `railway add --database`
  // or from the dashboard.
  if (svc.managed_on_railway) {
    manifests.push({ name: svc.name, kind: 'managed', file: '(Railway plugin)' });
    continue;
  }
  const path = join(OUT_DIR, `${svc.name}.json`);
  writeFileSync(path, JSON.stringify(buildInfraConfig(svc), null, 2) + '\n');
  manifests.push({ name: svc.name, kind: 'infra', file: `railway/${svc.name}.json` });
  written++;
}

for (const svc of JOB_SERVICES) {
  const path = join(OUT_DIR, `${svc.name}.json`);
  writeFileSync(path, JSON.stringify(buildJobConfig(svc), null, 2) + '\n');
  manifests.push({ name: svc.name, kind: 'job', file: `railway/${svc.name}.json` });
  written++;
}

// Write a manifest index for humans.
const readmeLines = [
  '# Railway service configs',
  '',
  'Auto-generated by `scripts/gen-railway-configs.mjs`. Do not edit by hand;',
  'update `scripts/deploy/shared/services.mjs` and re-run the generator:',
  '',
  '```',
  'node scripts/gen-railway-configs.mjs',
  '```',
  '',
  '## How to use these',
  '',
  'Railway reads one config file per service. In the Railway dashboard, for',
  'every service you create in your project:',
  '',
  '1. **Root Directory**: leave as `.` (repo root) — our Dockerfiles build',
  '   from the monorepo root, not from `apps/<name>/`.',
  '2. **Config Path**: set to `railway/<service>.json` (e.g.',
  '   `railway/api.json` for the Bam API service).',
  '3. Railway will read the Dockerfile path, start command, healthcheck and',
  '   watch patterns from that file.',
  '',
  'Environment variables still live in the Railway dashboard (or pushed via',
  '`railway variables set`); they are **not** in these JSON files. See each',
  "service's entry in `scripts/deploy/shared/services.mjs` for the required",
  'and optional env-var list.',
  '',
  '## Services in this project',
  '',
  '| Service | Kind | Config |',
  '|---------|------|--------|',
];
for (const m of manifests) {
  readmeLines.push(`| \`${m.name}\` | ${m.kind} | ${m.file} |`);
}
readmeLines.push('');
writeFileSync(join(OUT_DIR, 'README.md'), readmeLines.join('\n'));

// ─── Railway-flavored nginx config ────────────────────────────────────
//
// The frontend ingress container needs different upstream hostnames on
// Railway (`<service>.railway.internal`) than on docker-compose (the bare
// service name resolves on the compose bridge network). Rather than try
// to fully template the nginx file from the catalog, we read the canonical
// `infra/nginx/nginx-with-site.conf` (the file the compose flow mounts at
// runtime, which is kept up to date) and rewrite each `proxy_pass` whose
// hostname matches a known service. Anything else passes through unchanged.

function generateRailwayNginxConf() {
  const sourcePath = join(ROOT, 'infra/nginx/nginx-with-site.conf');
  const outPath = join(ROOT, 'infra/nginx/nginx.railway.conf');
  // CRLF is normalized to LF inside transformNginxForRailway before any regex work.
  // On a Windows checkout a lone `\r` is its own line boundary in `m` mode, which once
  // welded `listen 8080;` onto a comment line; nginx then had no valid listen, fell back
  // to port 80, and every Railway healthcheck on 8080 failed, silently freezing the
  // frontend at an old build in production.
  const source = readFileSync(sourcePath, 'utf8');

  // Valid upstream hostnames match docker-compose service names. Bam app services
  // bind to PORT=8080 on Railway; third-party images keep their default ports.
  // The transform itself lives in scripts/lib/railway-nginx.mjs (unit tested).
  const { out, counts } = transformNginxForRailway(source, {
    validHosts: [
      ...APP_SERVICES.map((s) => s.name),
      ...INFRA_SERVICES.map((s) => s.name),
      ...JOB_SERVICES.map((s) => s.name),
    ],
    appHosts: APP_SERVICES.map((s) => s.name),
  });

  const header = [
    '# AUTO-GENERATED by scripts/gen-railway-configs.mjs from',
    '# infra/nginx/nginx-with-site.conf — do not edit by hand. Re-run the',
    '# generator whenever the source nginx config changes:',
    '#',
    '#   node scripts/gen-railway-configs.mjs',
    '#',
    '# What\'s different from the source:',
    '#   1. Every `proxy_pass http://<service>:<port>` whose hostname matches',
    '#      a service in scripts/deploy/shared/services.mjs is rewritten to',
    '#      `proxy_pass http://<service>.railway.internal:<port>` so the',
    '#      ingress resolves backends through Railway\'s private DNS instead',
    '#      of the docker-compose bridge network.',
    '#   2. For Bam app services (api, helpdesk-api, mcp-server, …), the',
    '#      upstream port is rewritten to 8080 because Railway sets PORT=8080',
    '#      on every container and the services bind to that, NOT to their',
    '#      docker-compose nominal port (4000, 4001, 3001, …).',
    '#   3. Third-party services (minio, qdrant, livekit) keep their original',
    '#      ports because they ignore $PORT and bind to hardcoded defaults.',
    '#   4. The `listen N;` directive is rewritten to `listen 8080;` so the',
    '#      frontend container binds to Railway\'s assigned PORT and its own',
    '#      healthcheck passes.',
    '#   5. A `resolver __RESOLVER__ valid=10s;` directive is added to the',
    '#      server block. The entrypoint script replaces __RESOLVER__ with',
    '#      the nameservers from /etc/resolv.conf so nginx resolves upstream',
    '#      hostnames through Railway\'s DNS at request time (10s TTL)',
    '#      instead of caching the startup IP forever. Without this, any',
    '#      upstream redeploy gives the service a new internal IP and the',
    '#      frontend 502s at that route until it is also redeployed.',
    '#   6. Each proxy_pass upstream hostname is moved into a `set` variable',
    '#      followed by an explicit `rewrite` that reproduces the original',
    '#      URI substitution. nginx only consults the resolver when the',
    '#      proxy_pass URL contains a variable, so a hostname without the',
    '#      `$` indirection would still be statically resolved despite the',
    '#      resolver directive. Trust the generator for these transforms;',
    '#      edit infra/nginx/nginx-with-site.conf (the source) for any real',
    '#      config change.',
    '#',
    '',
  ].join('\n');

  writeFileSync(outPath, header + out);
  return { path: outPath, ...counts };
}

const nginxResult = generateRailwayNginxConf();

// ─── Environment variables documentation ─────────────────────────────

function generateEnvVarsDoc() {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# Railway environment variables');
  push('');
  push('Auto-generated by `scripts/gen-railway-configs.mjs` from the service');
  push('catalog at `scripts/deploy/shared/services.mjs` and the env-var hints');
  push('at `scripts/deploy/shared/env-hints.mjs`. Re-run the generator whenever');
  push('either of those changes.');
  push('');
  push('## Conventions on Railway');
  push('');
  push('- **Internal DNS**: Railway services in the same project resolve each');
  push('  other as `<service-name>.railway.internal`. The hostnames in the');
  push('  catalog (`api`, `banter-api`, `mcp-server`, `minio`, `qdrant`, …)');
  push('  match the names you give the services in the Railway dashboard.');
  push('- **Plugin references**: managed plugins (Postgres, Redis) expose');
  push('  their connection strings as injectable variables you reference like');
  push('  `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`.');
  push('- **Cross-service references**: any variable on another service can be');
  push('  pulled in with `${{<service>.<VAR>}}` — e.g. app services pull MinIO');
  push('  credentials from the minio service via `${{minio.MINIO_ROOT_USER}}`.');
  push('- **Public URL**: every variable below tagged "public" should be set to');
  push('  the public URL of the **frontend** service (the only externally-');
  push('  exposed service in this project).');
  push('');
  push('## Secrets you generate yourself');
  push('');
  push('Run these once and stash the values somewhere safe — every service');
  push('that uses the same secret must get the SAME value or sessions and');
  push('inter-service auth will break.');
  push('');
  push('```sh');
  push('# Shared session secret (api, helpdesk-api, banter-api, beacon-api, …)');
  push('openssl rand -hex 32');
  push('');
  push('# api ↔ helpdesk-api shared secret');
  push('openssl rand -hex 16');
  push('');
  push('# Internal service-to-service secret (bolt-api event ingestion)');
  push('openssl rand -hex 16');
  push('');
  push('# MinIO root credentials');
  push('openssl rand -hex 16   # MINIO_ROOT_USER');
  push('openssl rand -hex 24   # MINIO_ROOT_PASSWORD');
  push('');
  push('# LiveKit API credentials (only if you use voice/video)');
  push('openssl rand -hex 16   # LIVEKIT_API_KEY');
  push('openssl rand -hex 32   # LIVEKIT_API_SECRET');
  push('```');
  push('');
  push('## Per-service variables');
  push('');
  push('Each table lists every env var for that service. The **Value** column');
  push('shows what to type into the Railway dashboard, with `<placeholders>`');
  push('for things you have to fill in yourself. Required variables are flagged');
  push('with **R**, optional with `o`.');

  const allServices = [
    ...APP_SERVICES.map((s) => ({ kind: 'app', svc: s })),
    ...INFRA_SERVICES.filter((s) => !s.managed_on_railway).map((s) => ({ kind: 'infra', svc: s })),
    ...JOB_SERVICES.map((s) => ({ kind: 'job', svc: s })),
  ];

  for (const { svc } of allServices) {
    push('');
    push(`### ${svc.name}`);
    push('');
    push(`*${svc.description}*`);
    if (svc.is_public_ingress) {
      push('');
      push('> **This is the only public-facing service.** Configure a public');
      push('> domain on this Railway service; everything else stays internal.');
    }
    push('');
    if (!svc.env || ((svc.env.required ?? []).length === 0 && (svc.env.optional ?? []).length === 0)) {
      push('_No environment variables required._');
      continue;
    }
    push('| R/o | Variable | Kind | Value | Note |');
    push('|---|---|---|---|---|');
    const rows = [];
    for (const name of svc.env.required ?? []) {
      const h = hintFor(name);
      rows.push({ req: '**R**', name, h });
    }
    for (const name of svc.env.optional ?? []) {
      const h = hintFor(name);
      rows.push({ req: 'o', name, h });
    }
    for (const { req, name, h } of rows) {
      const note = (h.note ?? '').replace(/\|/g, '\\|');
      const value = String(h.value).replace(/\|/g, '\\|');
      push(`| ${req} | \`${name}\` | ${h.kind} | \`${value}\` | ${note} |`);
    }
  }

  push('');
  push('## Environment variables that need the same value on multiple services');
  push('');
  push('These are the secrets and references that MUST be identical across');
  push('several services. Set them once, then copy/reference everywhere.');
  push('');
  // Build a reverse map: var name -> services that need it
  const sharedSecrets = new Set([
    'SESSION_SECRET',
    'INTERNAL_HELPDESK_SECRET',
    'INTERNAL_SERVICE_SECRET',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
  ]);
  const varToServices = new Map();
  for (const svc of [...APP_SERVICES, ...INFRA_SERVICES, ...JOB_SERVICES]) {
    if (!svc.env) continue;
    for (const name of [...(svc.env.required ?? []), ...(svc.env.optional ?? [])]) {
      if (!sharedSecrets.has(name)) continue;
      if (!varToServices.has(name)) varToServices.set(name, []);
      varToServices.get(name).push(svc.name);
    }
  }
  for (const [name, services] of varToServices) {
    push(`- \`${name}\` — ${services.join(', ')}`);
  }
  push('');

  const outPath = join(OUT_DIR, 'env-vars.md');
  writeFileSync(outPath, lines.join('\n'));
  return outPath;
}

const envDocPath = generateEnvVarsDoc();

// ─── Final report ─────────────────────────────────────────────────────

process.stdout.write(`Wrote ${written} Railway configs to ${OUT_DIR}\n`);
for (const m of manifests) {
  process.stdout.write(`  - ${m.name.padEnd(14)} ${m.kind.padEnd(8)} ${m.file}\n`);
}
process.stdout.write(
  `\nWrote nginx.railway.conf (${nginxResult.rewrittenProxyPass} upstreams + ${nginxResult.rewrittenSetUpstream} set-variable upstreams + ${nginxResult.rewrittenResolver} docker resolvers + ${nginxResult.rewrittenListen} listen + ${nginxResult.rewrittenVariable} dynamic-DNS proxy_pass directives rewritten)\n`,
);
process.stdout.write(`  - ${nginxResult.path}\n`);
process.stdout.write(`\nWrote env-vars.md\n`);
process.stdout.write(`  - ${envDocPath}\n`);
