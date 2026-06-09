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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'railway');

// ─── Watch patterns ───────────────────────────────────────────────────
//
// A service is rebuilt when any matched file changes. We include the
// service's own source tree, its Dockerfile, the shared schema package
// (everything depends on it), the root lockfile, and the root package.json.

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
  if (service.extra_watch_patterns) {
    base.push(...service.extra_watch_patterns);
  }
  return base;
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
  const source = readFileSync(sourcePath, 'utf8');

  // Build the set of valid service hostnames (matches docker-compose service
  // names, which are the same as upstream names in the source nginx config).
  const validHosts = new Set([
    ...APP_SERVICES.map((s) => s.name),
    ...INFRA_SERVICES.map((s) => s.name),
    ...JOB_SERVICES.map((s) => s.name),
  ]);

  // Bam app services bind to PORT=8080 on Railway regardless of their
  // nominal docker-compose port, because they read process.env.PORT and
  // Railway sets PORT=8080 unconditionally. Third-party images
  // (minio/qdrant/livekit) ignore $PORT and keep their default ports.
  // We keep the original port when the upstream is third-party.
  const RAILWAY_DYNAMIC_PORT = 8080;
  const appHosts = new Set(APP_SERVICES.map((s) => s.name));
  const railwayPortFor = (host) =>
    appHosts.has(host) ? String(RAILWAY_DYNAMIC_PORT) : null;

  let rewrittenProxyPass = 0;
  let rewrittenListen = 0;

  // 1. Rewrite proxy_pass upstreams: add `.railway.internal`, swap the
  //    port to 8080 for Bam services, leave third-party ports alone.
  let out = source.replace(
    /proxy_pass(\s+)http:\/\/([a-z][a-z0-9-]*):(\d+)/gi,
    (match, ws, host, port) => {
      if (!validHosts.has(host)) return match;
      rewrittenProxyPass++;
      const railwayPort = railwayPortFor(host) ?? port;
      return `proxy_pass${ws}http://${host}.railway.internal:${railwayPort}`;
    },
  );

  // 2. The frontend nginx itself runs ON Railway and must bind to PORT=8080
  //    so Railway's healthcheck and public proxy can reach it. The source
  //    config uses two placeholders that entrypoint.sh substitutes at
  //    container start for the docker-compose flow:
  //
  //      __HTTP_LISTEN__      → "    listen 80;" (or empty for TLS modes)
  //      __TLS_LISTEN_BLOCK__ → ssl listen + cert + HSTS lines (or empty)
  //
  //    Neither substitution is correct for Railway: TLS terminates at
  //    Railway's edge proxy so no in-container cert, and the port must be
  //    8080 (not 80) for Railway's healthcheck to land. Materialize the
  //    final values into the railway profile so entrypoint.sh's
  //    `grep -q '__HTTP_LISTEN__'` test returns false on Railway and the
  //    TLS substitution branch is bypassed entirely.
  out = out.replace(/^\s*__HTTP_LISTEN__\s*$/m, `    listen ${RAILWAY_DYNAMIC_PORT};`);
  out = out.replace(/^\s*__TLS_LISTEN_BLOCK__\s*$/m, '');
  rewrittenListen++;

  // 2b. Rewrite any remaining `listen N;` directive (typically none after the
  //     placeholder substitution above, but kept for any future inline ones)
  //     to `listen 8080;`. Source IPs and SSL options are preserved.
  //
  //     Walk line-by-line so we can skip comment lines. The source has a
  //     documentation block describing what entrypoint.sh injects (literally
  //     "listen 80;" inside a `# … "listen 80;" or "" …` comment), and we
  //     must NOT rewrite those — both because they're not real directives,
  //     and because step 3's resolver insertion would split the comment in
  //     half and the orphan trailing fragment would be parsed as a real
  //     directive at boot, crashing nginx with a healthcheck-loop on Railway.
  //     A leading `#` (after any indentation) is the only nginx comment form,
  //     so a simple prefix test is sufficient.
  const isComment = (line) => /^\s*#/.test(line);
  const listenRewriteRe = /(\blisten\s+)(\d+)([^;]*);/g;
  const listenLines = out.split('\n').map((line) => {
    if (isComment(line)) return line;
    return line.replace(listenRewriteRe, (_match, prefix, port, suffix) => {
      if (port === String(RAILWAY_DYNAMIC_PORT)) return _match;
      rewrittenListen++;
      return `${prefix}${RAILWAY_DYNAMIC_PORT}${suffix};`;
    });
  });
  out = listenLines.join('\n');

  // 3. Inject a `resolver` directive right after the listen. Without it,
  //    nginx resolves upstream hostnames ONCE at config load and caches the
  //    IP forever — so any time an upstream service (api, site, helpdesk-api,
  //    …) is redeployed its internal IP changes and the frontend keeps
  //    hitting the dead old IP until someone also redeploys frontend. The
  //    `__RESOLVER__` placeholder is replaced at container start by
  //    infra/nginx/entrypoint.sh with the nameserver(s) from
  //    /etc/resolv.conf, so the config stays portable.
  //
  //    Same comment-skip applies here: a `listen N;` mention inside a
  //    `# …` documentation block must not get a resolver line injected
  //    after it, or the comment splits and the second half becomes a
  //    real directive.
  const resolverRe = /(\blisten\s+\d+[^;]*;)/;
  let resolverInjected = false;
  const resolverLines = out.split('\n').map((line) => {
    if (resolverInjected || isComment(line)) return line;
    const replaced = line.replace(resolverRe, `$1\n    resolver __RESOLVER__ valid=10s;`);
    if (replaced !== line) resolverInjected = true;
    return replaced;
  });
  out = resolverLines.join('\n');

  // 4. Rewrite each `proxy_pass http://<host>.railway.internal:<port>[<uri>]`
  //    to use a variable so nginx uses the resolver (with 10s TTL) to re-
  //    resolve the hostname at request time. nginx only consults the
  //    resolver when the upstream URL contains a variable; a static hostname
  //    is resolved once at startup and the IP is cached forever.
  //
  //    Because variable-style proxy_pass cannot do URI rewriting itself
  //    (nginx docs: "URI is passed as-is"), we replace the static-URI form
  //    with an explicit `rewrite ... break` that reproduces the original
  //    path substitution, then a URI-less proxy_pass to the variable.
  let rewrittenVariable = 0;
  const lines = out.split('\n');
  const resultLines = [];
  let currentLoc = null;
  let braceDepth = 0;
  let locBraceDepth = 0;
  let varSeq = 0;
  const locRe = /^(\s*)location\s+([^\s{]+(?:\s+[^\s{]+)*)\s*\{\s*$/;
  const closeRe = /^\s*}\s*$/;
  const openRe = /\{/;
  const proxyRe =
    /^(\s*)proxy_pass\s+http:\/\/([a-z][a-z0-9-]*\.railway\.internal):(\d+)(\/[^\s;]*)?;(\s*)$/;
  for (const line of lines) {
    const mLoc = line.match(locRe);
    if (mLoc) {
      currentLoc = mLoc[2];
      locBraceDepth = braceDepth;
      braceDepth++;
      resultLines.push(line);
      continue;
    }
    if (closeRe.test(line)) {
      braceDepth = Math.max(0, braceDepth - 1);
      if (currentLoc && braceDepth === locBraceDepth) currentLoc = null;
      resultLines.push(line);
      continue;
    }
    if (openRe.test(line)) {
      // non-location block opening (e.g. `server {`). Track depth.
      braceDepth++;
    }
    const mProxy = line.match(proxyRe);
    if (mProxy && currentLoc) {
      const [, indent, host, port, uri, trailing] = mProxy;
      const varName = `$rw_upstream_${++varSeq}`;
      resultLines.push(`${indent}set ${varName} "${host}";`);
      if (uri && uri !== '') {
        // Strip the `= ` exact-match modifier (and any leading whitespace)
        // from currentLoc so the rewrite regex sees only the URI path.
        // Without this, `location = /mcp` would produce a rewrite anchored
        // on literal `= /mcp`, which nginx parses as a broken regex.
        const locPath = currentLoc.replace(/^=\s+/, '');
        const locEsc = locPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        resultLines.push(
          `${indent}rewrite ^${locEsc}(.*)$ ${uri}$1 break;`,
        );
      }
      resultLines.push(
        `${indent}proxy_pass http://${varName}:${port};${trailing ?? ''}`,
      );
      rewrittenVariable++;
      continue;
    }
    resultLines.push(line);
  }
  out = resultLines.join('\n');

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
  return {
    path: outPath,
    rewrittenProxyPass,
    rewrittenListen,
    rewrittenVariable,
  };
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
  `\nWrote nginx.railway.conf (${nginxResult.rewrittenProxyPass} upstreams + ${nginxResult.rewrittenListen} listen + ${nginxResult.rewrittenVariable} dynamic-DNS proxy_pass directives rewritten)\n`,
);
process.stdout.write(`  - ${nginxResult.path}\n`);
process.stdout.write(`\nWrote env-vars.md\n`);
process.stdout.write(`  - ${envDocPath}\n`);
