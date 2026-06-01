// Docker Compose platform adapter — local / self-hosted deployment.
// Zero dependencies (node:child_process, node:fs, node:path only).

import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bold, check, cross, dim, green, yellow, cyan, red, warn } from '../shared/colors.mjs';
import { confirm, ask } from '../shared/prompt.mjs';
import { checkDockerPrerequisites } from '../shared/prerequisites.mjs';
import { provisionCerts } from '../shared/tls.mjs';
import { runInitialIssuance, buildRenewalTask } from '../shared/letsencrypt.mjs';
import { loadDeploySettings } from '../shared/db-settings.mjs';
import { decryptDeployToken } from '../shared/decrypt-token.mjs';

const name = 'Docker Compose';
const description = 'Run everything locally with Docker (simplest)';

/**
 * Detect whether docker compose v2 is available, fall back to v1.
 */
function composeCmd() {
  try {
    execSync('docker compose version', { stdio: 'pipe' });
    return 'docker compose';
  } catch {
    return 'docker-compose';
  }
}

/**
 * Run a shell command and stream output, returning stdout on success.
 *
 * `opts.env` extends process.env for the child. Use this for build-time
 * vars instead of bash `VAR=value command` prefixing — that syntax is
 * unparseable on Windows cmd.exe and breaks deploys there.
 */
function runShell(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: opts.silent ? 'pipe' : 'inherit',
      cwd: opts.cwd || process.cwd(),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    if (opts.silent) {
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    }
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Command failed (exit ${code}): ${cmd}\n${stderr}`));
    });
    child.on('error', reject);
  });
}

/**
 * Sleep for ms milliseconds.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wrapper around loadDeploySettings that never throws. If anything goes
 * wrong (stack down, postgres unreachable, malformed rows, etc.) the
 * deploy script keeps going with hardcoded defaults.
 */
async function safeLoadDeploySettings() {
  try {
    return await loadDeploySettings();
  } catch {
    return null;
  }
}

/**
 * Normalize a git remote URL for equality comparison. Strips trailing
 * `.git`, lowercases the host, and drops trailing slashes. Returns the
 * input unchanged if it doesn't parse — better to compare too strictly
 * than to misidentify two unrelated repos as the same.
 */
function normalizeRepoUrl(input) {
  if (typeof input !== 'string') return input;
  let s = input.trim();
  // Strip trailing whitespace + .git
  if (s.endsWith('.git')) s = s.slice(0, -4);
  // SSH form (git@github.com:owner/repo) → normalize to https for compare
  const sshMatch = s.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    s = `https://${sshMatch[1].toLowerCase()}/${sshMatch[2]}`;
  } else {
    try {
      const u = new URL(s);
      u.hash = '';
      u.search = '';
      u.username = '';
      u.password = '';
      u.host = u.host.toLowerCase();
      s = u.toString();
    } catch {
      // not a URL — fall through with the trimmed string
    }
  }
  return s.replace(/\/+$/, '');
}

/**
 * Read SESSION_SECRET from .env at the repo root. Returns null if .env
 * is missing or the key isn't present. Kept local to this module so the
 * decryption flow doesn't depend on a process-wide env load.
 */
function readSessionSecretFromEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return null;
    const text = fs.readFileSync(envPath, 'utf8');
    const match = text.match(/^SESSION_SECRET=(.+)$/m);
    if (!match) return null;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Inject a GitHub PAT into an https://github.com/... URL via basic auth
 * (`https://oauth2:<token>@github.com/...`). Returns null if the URL is
 * not https or not on github.com — we don't want to silently leak a
 * PAT to an arbitrary host.
 */
function injectGitHubToken(url, token) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!/(^|\.)github\.com$/i.test(u.host)) return null;
    u.username = 'oauth2';
    u.password = encodeURIComponent(token);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Pull updates for `branch`, honoring SuperUser-overridden repo URL and
 * (optionally) injecting a decrypted GitHub PAT into the pull URL for
 * private-repo authentication. The token is wiped from local memory
 * immediately after the pull completes (subject to GC; we can't force
 * Node to scrub the buffer, but we drop our references and shadow the
 * variable).
 *
 * @param {object} args
 * @param {string} args.branch - Branch to pull.
 * @param {string|null} args.pullUrl - Override repo URL, or null to use origin.
 * @param {string|null} args.encryptedToken - SU-stored `enc:`-prefixed token, or null.
 */
async function runPullWithSettings({ branch, pullUrl, encryptedToken }) {
  let plaintextToken = null;
  let authedUrl = null;

  if (encryptedToken) {
    const sessionSecret = readSessionSecretFromEnv();
    if (!sessionSecret) {
      console.log(
        dim('  (SESSION_SECRET not in .env — cannot decrypt SuperUser PAT; pulling without it)'),
      );
    } else {
      plaintextToken = decryptDeployToken(encryptedToken, sessionSecret);
      if (!plaintextToken) {
        console.log(
          dim('  (SuperUser PAT failed to decrypt — has SESSION_SECRET rotated? Pulling without it)'),
        );
      }
    }
  }

  // If we have an override URL OR a token to inject, do a manual fetch
  // + merge against an explicit URL rather than `git pull origin <branch>`.
  // Otherwise fall back to the simpler invocation against the locally
  // configured origin.
  const effectiveUrl = pullUrl ?? null;
  if (effectiveUrl || plaintextToken) {
    // Use the override URL if present, else origin's URL.
    let targetUrl = effectiveUrl;
    if (!targetUrl) {
      try {
        targetUrl = execSync('git remote get-url origin', {
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
      } catch {
        targetUrl = null;
      }
    }

    if (plaintextToken && targetUrl) {
      const injected = injectGitHubToken(targetUrl, plaintextToken);
      if (injected) {
        authedUrl = injected;
      } else {
        console.log(
          dim('  (SuperUser PAT only supports https://github.com/... URLs — pulling without it)'),
        );
      }
    }

    const urlForPull = authedUrl ?? targetUrl;
    if (urlForPull) {
      try {
        // Use array form via spawnSync-style execFileSync to keep the
        // URL out of the shell — the URL may legally contain `:` `@`
        // `?` and other characters that shells interpret. We also pass
        // it as an explicit positional so no quoting is required.
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['pull', urlForPull, branch], {
          stdio: 'inherit',
        });
      } finally {
        // Drop references to the plaintext token + authed URL ASAP.
        // Node won't zero the heap for us, but losing the references
        // makes the windows for accidental capture (closures, error
        // traces) as short as possible.
        plaintextToken = null;
        authedUrl = null;
      }
      return;
    }
  }

  // No override / no token / no resolvable URL — fall through to the
  // simple `git pull origin <branch>` against the configured remote.
  execSync(`git pull origin ${branch}`, { stdio: 'inherit' });
}

/**
 * Check platform-specific prerequisites.
 */
async function checkPrerequisites() {
  console.log(bold('Checking Docker Compose setup...\n'));

  // Docker + Docker Compose installed and running
  checkDockerPrerequisites();

  // Check compose file exists
  const composeFile = path.resolve(process.cwd(), 'docker-compose.yml');
  if (fs.existsSync(composeFile)) {
    console.log(`  ${check} docker-compose.yml found`);
  } else {
    console.log(`  ${cross} docker-compose.yml not found`);
    throw new Error('docker-compose.yml is missing from the repository root.');
  }

  // Docker memory (informational)
  try {
    const memRaw = execSync('docker info --format "{{.MemTotal}}"', { stdio: 'pipe', encoding: 'utf8' }).trim();
    const memBytes = parseInt(memRaw, 10);
    if (!isNaN(memBytes)) {
      const memGB = memBytes / (1024 ** 3);
      if (memGB < 4) {
        console.log(`  ${warn} Docker has ${memGB.toFixed(1)} GB RAM. 4+ GB recommended.`);
      } else {
        console.log(`  ${check} Docker memory: ${memGB.toFixed(1)} GB`);
      }
    }
  } catch {
    // non-critical
  }

  // Disk space (best effort, non-Windows)
  if (process.platform !== 'win32') {
    try {
      const df = execSync("df -h . | tail -1 | awk '{print $4}'", { stdio: 'pipe', encoding: 'utf8' }).trim();
      console.log(`  ${check} Available disk space: ${df}`);
    } catch {
      // non-critical
    }
  }

  console.log('');
  return true;
}

/**
 * Write the .env file from a key-value config object.
 */
export function writeEnvFile(envConfig) {
  const envPath = path.resolve(process.cwd(), '.env');
  const lines = [
    '# BigBlueBam environment configuration',
    `# Generated by deployment setup on ${new Date().toISOString()}`,
    '# Edit carefully -- secrets below are auto-generated.',
    '',
  ];

  const sections = {
    '# --- Core ---': ['NODE_ENV', 'DOMAIN', 'BASE_URL'],
    '# --- Database ---': ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'DATABASE_URL'],
    '# --- Redis ---': ['REDIS_PASSWORD', 'REDIS_URL'],
    '# --- Auth ---': ['SESSION_SECRET', 'INTERNAL_HELPDESK_SECRET', 'INTERNAL_SERVICE_SECRET'],
    '# --- Storage ---': [
      'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD',
      'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION', 'S3_FORCE_PATH_STYLE',
    ],
    '# --- Vector DB ---': ['QDRANT_URL', 'QDRANT_API_KEY'],
    '# --- LiveKit ---': ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
    '# --- Email ---': ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
    '# --- OAuth ---': ['OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET'],
    '# --- AI ---': ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  };

  for (const [header, keys] of Object.entries(sections)) {
    const sectionLines = [];
    for (const key of keys) {
      if (envConfig[key] != null && envConfig[key] !== '') {
        sectionLines.push(`${key}=${envConfig[key]}`);
      }
    }
    if (sectionLines.length > 0) {
      lines.push(header);
      lines.push(...sectionLines);
      lines.push('');
    }
  }

  // Catch any keys not in sections
  const allListed = new Set(Object.values(sections).flat());
  for (const [key, val] of Object.entries(envConfig)) {
    if (!allListed.has(key) && val != null && val !== '') {
      lines.push(`${key}=${val}`);
    }
  }

  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600, encoding: 'utf8' });
  return envPath;
}

/**
 * Render `infra/livekit/livekit.yaml` from its `.template` sibling using
 * the LIVEKIT_API_KEY / LIVEKIT_API_SECRET in envConfig (which were
 * generated by secrets.mjs and just written to .env). Replaces the
 * placeholders __LIVEKIT_API_KEY__ and __LIVEKIT_API_SECRET__.
 *
 * Why a render step instead of the LIVEKIT_KEYS env var override:
 * livekit-server reads its keys block from the yaml, and the
 * webhook.api_key field has to reference one of those keys to sign
 * outbound webhooks. Setting LIVEKIT_KEYS via env doesn't fix the
 * webhook side without further config gymnastics — templating is the
 * cleanest, most legible path. The rendered file is gitignored.
 *
 * Falls back to devkey/secret if env vars are unset so a fresh
 * checkout running `docker compose up -d` without going through the
 * deploy script first gets a working (insecure-but-clear) config.
 */
export function renderLivekitConfig(envConfig) {
  const templatePath = path.resolve(process.cwd(), 'infra/livekit/livekit.yaml.template');
  const outPath = path.resolve(process.cwd(), 'infra/livekit/livekit.yaml');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`LiveKit template missing: ${templatePath}`);
  }
  const template = fs.readFileSync(templatePath, 'utf8');
  const apiKey = envConfig.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = envConfig.LIVEKIT_API_SECRET || 'secret';
  const rendered = template
    .replace(/__LIVEKIT_API_KEY__/g, apiKey)
    .replace(/__LIVEKIT_API_SECRET__/g, apiSecret);
  fs.writeFileSync(outPath, rendered, { encoding: 'utf8' });
  return outPath;
}

/**
 * Build and start the full stack.
 *
 * @param {object} envConfig - Resolved env config from main.mjs
 * @param {object} [options]
 * @param {string} [options.branch='stable'] - Git branch to track for updates.
 *   Operator is prompted in main.mjs and the choice is saved in
 *   `.deploy-state.json` so subsequent runs offer to reuse it. Defaults to
 *   `stable` — the validated production branch. Choose `main` for bleeding-
 *   edge deploys that may be unstable.
 */
async function deploy(envConfig, { branch = 'stable', tlsConfig = null } = {}) {
  const dc = composeCmd();

  // 1. Write .env
  process.stdout.write('Writing .env file... ');
  const envPath = writeEnvFile(envConfig);
  console.log(`${check} ${dim(envPath)}`);

  // 1.5. Render the LiveKit config from its template using the
  // generated LIVEKIT_API_KEY / LIVEKIT_API_SECRET from .env. Without
  // this step, infra/livekit/livekit.yaml stays at its template form
  // (placeholders) and the LiveKit server fails to load. The rendered
  // file is gitignored — it contains the actual deployment secret.
  // Falls back to devkey/secret if env vars are unset, so a fresh
  // checkout running `docker compose up -d` directly still has a
  // working LiveKit yaml.
  process.stdout.write('Rendering LiveKit config... ');
  try {
    renderLivekitConfig(envConfig);
    console.log(`${check} ${dim('infra/livekit/livekit.yaml')}`);
  } catch (err) {
    console.log(red('failed'));
    console.log(dim(`  ${err.message ?? err}`));
    console.log(dim('  LiveKit will fall back to its template defaults until you fix this.'));
  }

  // 1a. Provision TLS certs (if the operator opted into TLS). Runs BEFORE
  // `docker compose up` so the frontend container's entrypoint detects
  // certs at first boot. Letsencrypt is the exception — its provisioning
  // happens AFTER nginx is up so certbot can serve the ACME challenge.
  // See docs/guides/local-ssl-notes.md for the full picture.
  if (tlsConfig && tlsConfig.source !== 'letsencrypt') {
    const certsDir = path.resolve(process.cwd(), 'certs');
    process.stdout.write(`Provisioning TLS cert (${tlsConfig.source})... `);
    try {
      provisionCerts(tlsConfig, { domain: envConfig.DOMAIN || 'localhost', certsDir });
      console.log(`${check} ${dim(certsDir + '/local.{crt,key}')}`);
    } catch (err) {
      console.log(red('failed'));
      console.log(dim(`  ${err.message ?? err}`));
      console.log(dim('  The stack will boot but nginx will run HTTP-only until you fix this.'));
    }
  }

  // Check for updates if this is an existing installation. The behavior
  // here is overlaid by SuperUser-managed deploy settings (see
  // docs/plans/deploy-settings-contract.md):
  //   - deploy_auto_update_enabled === false → skip the pull entirely
  //   - deploy_repo_url override → use that URL for the pull (not the
  //     configured origin remote); we never modify the actual origin URL
  //   - deploy_github_token (encrypted) → inject into the pull URL via
  //     basic auth for this one pull and wipe from memory immediately
  // Any of the lookups can fail silently; we fall back to current behavior.
  const isUpgrade = fs.existsSync(path.resolve(process.cwd(), '.deploy-state.json'));
  if (isUpgrade) {
    const settings = await safeLoadDeploySettings();

    if (settings?.deploy_auto_update_enabled === false) {
      console.log('');
      console.log(dim('  (auto-update disabled via SuperUser settings — skipping pull)'));
      console.log('');
    } else {
      console.log(`\nChecking for updates on ${bold(branch)}...`);

      // Resolve the pull URL. Defaults to origin (`git pull origin
      // <branch>` uses the existing remote). If SuperUser configured an
      // override that differs from the configured origin URL, swap to
      // the override for this pull only.
      let pullUrl = null;
      let pullRefspec = branch;
      let originUrl = null;
      try {
        originUrl = execSync('git remote get-url origin', {
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
      } catch {
        originUrl = null;
      }

      if (
        settings?.deploy_repo_url &&
        originUrl &&
        normalizeRepoUrl(settings.deploy_repo_url) !== normalizeRepoUrl(originUrl)
      ) {
        console.log(dim(`  (SuperUser override active: ${settings.deploy_repo_url})`));
        pullUrl = settings.deploy_repo_url;
      } else if (settings?.deploy_repo_url && !originUrl) {
        // No origin configured locally — use the override directly.
        console.log(dim(`  (SuperUser override active: ${settings.deploy_repo_url})`));
        pullUrl = settings.deploy_repo_url;
      }

      try {
        execSync(`git fetch origin ${branch}`, { stdio: 'pipe', timeout: 15000 });
        const behind = execSync(`git rev-list HEAD..origin/${branch} --count`, { stdio: 'pipe', encoding: 'utf8' }).trim();

        if (behind !== '0') {
          console.log(`\n${yellow(`${behind} new commit(s) available on ${branch}.`)}\n`);
          try {
            const log = execSync(`git log HEAD..origin/${branch} --oneline --max-count=10`, { stdio: 'pipe', encoding: 'utf8' }).trim();
            console.log(dim(log));
            console.log('');
          } catch {}

          if (await confirm('Pull updates before rebuilding?', true)) {
            await runPullWithSettings({
              branch,
              pullUrl,
              encryptedToken: settings?.deploy_github_token_encrypted ?? null,
            });
            console.log(`${check} Code updated.\n`);
          }
        } else {
          console.log(`${check} Already up to date.\n`);
        }
      } catch {
        console.log(dim(`  Could not check for updates on ${branch} (no git or no network).\n`));
      }
    }
  }

  // 2. Build compose args
  const composeFiles = ['-f', 'docker-compose.yml'];
  const sitePath = path.resolve(process.cwd(), 'site');
  if (fs.existsSync(sitePath) && fs.existsSync(path.join(sitePath, 'package.json'))) {
    composeFiles.push('-f', 'docker-compose.site.yml');
    console.log(`  ${dim('site/ detected -- enabling marketing site overlay')}`);
  }
  const fileFlags = composeFiles.join(' ');

  // 3. Pull images
  console.log('\nPulling Docker images (this may take a few minutes)...\n');
  try {
    await runShell(`${dc} ${fileFlags} pull`);
    console.log(`\n${check} Images pulled`);
  } catch {
    console.log(`\n${warn} Some images could not be pulled -- they will be built locally`);
  }

  // 4. Build and start
  const gitCommit = (() => { try { return execSync('git rev-parse HEAD', { stdio: 'pipe', encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  const buildDate = new Date().toISOString();

  // On upgrades, we must defeat two traps that have each cost this project
  // hours of "column does not exist" debugging (see CLAUDE.md → "Applying a
  // new migration to a long-running stack"):
  //
  //   1. Docker's build cache + WSL2 file sync will silently drop new
  //      migration files from the api image context. A plain `up -d --build`
  //      is not enough — force `--no-cache` on the api image so buildkit
  //      can't reuse a stale COPY layer that's missing the new SQL file.
  //
  //   2. The `migrate` sidecar is cached via `service_completed_successfully`
  //      in docker-compose.yml, so `up -d` will NOT re-run it on an existing
  //      stack even when the api image contains new migrations. We must
  //      explicitly invoke `compose run --rm migrate` after the rebuild.
  //
  // Both happen automatically on the upgrade path so operators never have
  // to know this exists.
  if (isUpgrade) {
    console.log('\nRebuilding api image with --no-cache (ensures new migrations are baked in)...\n');
    await runShell(`${dc} ${fileFlags} build --no-cache api`, {
      env: { GIT_COMMIT: gitCommit, BUILD_DATE: buildDate },
    });
    console.log(`\n${check} api image rebuilt`);

    console.log('\nRunning database migrations (explicit sidecar invocation)...\n');
    try {
      // Bring postgres up first so the migrate sidecar has something to connect to.
      await runShell(`${dc} ${fileFlags} up -d postgres`);
      await runShell(`${dc} ${fileFlags} run --rm migrate`);
      console.log(`\n${check} Migrations applied`);
    } catch (err) {
      console.log(`\n${red('Migration step failed.')} ${dim(String(err?.message || err))}`);
      console.log(dim('  Check logs with: docker compose logs migrate'));
      console.log(dim('  See docs/guides/deployment.md → Updating for the manual fallback.'));
      throw err;
    }
  }

  console.log('\nBuilding and starting services...\n');
  await runShell(`${dc} ${fileFlags} up -d --build`, {
    env: { GIT_COMMIT: gitCommit, BUILD_DATE: buildDate },
  });
  console.log(`\n${check} All services started`);

  // 5. Wait for API to be healthy
  console.log('');
  process.stdout.write('Waiting for API to be ready... ');
  const maxWait = 120_000;
  const start = Date.now();
  let apiReady = false;

  while (Date.now() - start < maxWait) {
    try {
      execSync(
        `${dc} ${fileFlags} exec -T api node -e "fetch('http://localhost:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"`,
        { stdio: 'pipe', timeout: 10_000 },
      );
      apiReady = true;
      break;
    } catch {
      await sleep(3000);
    }
  }

  if (apiReady) {
    console.log(check);
  } else {
    console.log(yellow('[timeout]'));
    console.log(dim('  The API may still be starting. Check logs with: docker compose logs -f api'));
  }

  // 6. Let's Encrypt issuance (post-up, since certbot needs nginx serving
  //    /.well-known/acme-challenge/). The other three cert sources were
  //    already provisioned in step 1a before `compose up`.
  if (tlsConfig?.source === 'letsencrypt' && tlsConfig.letsencrypt) {
    console.log('');
    console.log(bold('Issuing Let\'s Encrypt certificate...'));
    console.log(dim('  certbot will validate ' + tlsConfig.letsencrypt.domain + ' over HTTP-01.'));
    const result = runInitialIssuance({
      domain: tlsConfig.letsencrypt.domain,
      email: tlsConfig.letsencrypt.email,
      composeBin: dc,
    });
    if (result.ok) {
      console.log(`${check} Cert issued and symlinked into ${dim('./certs/local.{crt,key}')}`);
      console.log(dim('  Reloading nginx so the new cert takes effect...'));
      try {
        await runShell(`${dc} ${fileFlags} exec -T frontend nginx -s reload`);
        console.log(`${check} nginx reloaded`);
      } catch (err) {
        console.log(`${yellow('nginx reload failed; restart frontend manually:')} ${dim(`${dc} restart frontend`)}`);
      }

      // Renewal task. Print instructions instead of installing the cron
      // entry automatically — operators frequently disable system cron
      // (NAS hosts often have non-standard schedulers) and silently
      // installing into a non-running cron daemon would create a
      // false sense of "renewal handled" that breaks at month 3.
      const task = buildRenewalTask({ projectDir: process.cwd(), composeBin: dc });
      console.log('');
      console.log(bold('Auto-renewal:'));
      for (const line of task.instructions) {
        console.log(dim('  ' + line));
      }
    } else {
      console.log(`${red('Let\'s Encrypt issuance failed:')} ${dim(result.reason)}`);
      console.log(dim('  The stack is up but nginx is HTTP-only. Re-run the deploy script after'));
      console.log(dim('  resolving the issue (most often: domain not pointing at this host, or'));
      console.log(dim('  port 80 not reachable from the public internet).'));
    }
  }

  return apiReady;
}

/**
 * Run a command inside a running service container.
 */
async function runCommand(service, cmd) {
  const dc = composeCmd();
  const fullCmd = `${dc} exec -T ${service} ${cmd}`;
  return runShell(fullCmd, { silent: true });
}

/**
 * Verify a login works by hitting the auth endpoint.
 */
async function verifyLogin(email, password) {
  const dc = composeCmd();
  const escapedEmail = email.replace(/'/g, "'\\''");
  const escapedPassword = password.replace(/'/g, "'\\''");
  const script = `fetch('http://localhost:4000/b3/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${escapedEmail}',password:'${escapedPassword}'})}).then(r=>{if(!r.ok)throw new Error('fail');process.exit(0)}).catch(()=>process.exit(1))`;
  await runShell(`${dc} exec -T api node -e "${script}"`, { silent: true });
}

/**
 * Stop the stack (no -v, data is sacred).
 */
async function stop() {
  const dc = composeCmd();
  await runShell(`${dc} down`);
}

export default {
  name,
  description,
  checkPrerequisites,
  writeEnvFile,
  deploy,
  runCommand,
  verifyLogin,
  stop,
};
