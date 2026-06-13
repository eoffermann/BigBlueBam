#!/usr/bin/env node

// BigBlueBam Deployment Orchestrator
// Zero npm dependencies — Node 22 built-ins only.

import { banner, select, confirm, ask } from './shared/prompt.mjs';
import { loadState, saveState, isPhaseComplete, markPhaseComplete, resetState } from './shared/state.mjs';
import { checkSharedPrerequisites } from './shared/prerequisites.mjs';
import { chooseDeployBranch } from './shared/branch-select.mjs';
import {
  generateSecrets,
  promptStorageChoice,
  promptVectorDbChoice,
  promptLiveKitChoice,
  promptOptionalIntegrations,
  promptRootRedirect,
  buildEnvConfig,
} from './shared/secrets.mjs';
import { createSuperUser } from './shared/admin-setup.mjs';
import { printSummary } from './shared/summary.mjs';
import { maybeAdvancedPortMapping } from './shared/port-mapping.mjs';
import { promptTlsConfig } from './shared/tls.mjs';
import { bold, dim, green, red, yellow, cyan, check, cross } from './shared/colors.mjs';

// Platform modules
import railway from './platforms/railway.mjs';
import dockerCompose from './platforms/docker-compose.mjs';

const PLATFORMS = [dockerCompose, railway];

async function main() {
  banner('BigBlueBam Deployment Setup');

  // --- Auxiliary Railway subcommands (operate on an already-deployed stack) ---
  // These short-circuit the full guided flow. They are Railway-only.
  const argv = process.argv;
  if (argv.includes('--reconcile') || argv.includes('--reconcile-dry-run')) {
    const dryRun = argv.includes('--reconcile-dry-run');
    if (typeof railway.reconcile !== 'function') throw new Error('Reconcile is only supported on the Railway platform.');
    await railway.reconcile({ dryRun });
    return;
  }
  if (argv.includes('--verify')) {
    if (typeof railway.verify !== 'function') throw new Error('Verify is only supported on the Railway platform.');
    // Optional --url=<host> ; token comes from BBB_VERIFY_TOKEN.
    const urlArg = argv.find((a) => a.startsWith('--url='));
    await railway.verify({ publicUrl: urlArg ? urlArg.slice('--url='.length) : null });
    return;
  }

  // Railway referral. Signing up with the referral code doesn't cost the
  // operator anything extra — it just gives BigBlueBam a small Railway
  // credit that helps fund continued development. Shown before the
  // "Welcome" banner so it's the first thing a new user sees; framed so
  // Docker-Compose-only operators can safely ignore it.
  console.log(`${bold('★ Deploying to Railway?')}`);
  console.log('  If you sign up through our referral link, Railway gives BigBlueBam a');
  console.log('  small credit — it costs you nothing extra and helps support ongoing');
  console.log('  development of this project:');
  console.log('');
  console.log(`  ${cyan('https://railway.com?referralCode=xCAYHN')}`);
  console.log('');
  console.log(dim('  (Deploying with Docker Compose instead? You can skip this — no referral needed.)'));
  console.log('');

  console.log("Welcome to BigBlueBam! Let's get you set up.\n");
  console.log('This will take about 10 minutes. Here is what we will do:\n');
  console.log('  1. Choose your hosting platform');
  console.log('  2. Check prerequisites');
  console.log('  3. Configure services and integrations');
  console.log('  4. Generate secrets and write .env');
  console.log('  5. Build and launch everything');
  console.log('  6. Create your admin account');
  console.log('');

  const state = loadState();

  // --- Handle --reset flag ---
  if (process.argv.includes('--reset')) {
    if (await confirm('This will reset all deployment state. Continue?', false)) {
      resetState();
      console.log(`${check} State reset. Starting fresh.\n`);
      return main(); // restart
    }
    return;
  }

  // --- Phase 1: Platform selection ---
  let platform;
  if (state.platform && !process.argv.includes('--reconfigure')) {
    const prev = PLATFORMS.find((p) => p.name === state.platform);
    if (prev && await confirm(`Continue with ${bold(prev.name)}?`, true)) {
      platform = prev;
    }
  }
  if (!platform) {
    const choice = await select('Where are you deploying?', PLATFORMS.map((p) => ({
      label: p.name,
      value: p.name,
      description: p.description,
    })));
    platform = PLATFORMS.find((p) => p.name === choice);
    state.platform = choice;
    saveState(state);
  }

  // --- Phase 1b: Branch selection ---
  //
  // BigBlueBam uses a two-branch model: `stable` for production deploys
  // (validated on main first) and `main` for bleeding-edge. Ask once here
  // and save the choice to state; subsequent runs offer to reuse it.
  let branch;
  if (state.branch && !process.argv.includes('--reconfigure')) {
    if (await confirm(`Continue deploying ${bold(state.branch)}?`, true)) {
      branch = state.branch;
    }
  }
  if (!branch) {
    console.log('');
    branch = await chooseDeployBranch({ previous: state.branch });
    state.branch = branch;
    saveState(state);
  }

  // --- Phase 2: Prerequisites ---
  if (!isPhaseComplete(state, 'prerequisites')) {
    console.log('');
    checkSharedPrerequisites();
    await platform.checkPrerequisites();
    markPhaseComplete(state, 'prerequisites');
    saveState(state);
  } else {
    if (await confirm('Prerequisites were already checked. Re-check?', false)) {
      checkSharedPrerequisites();
      await platform.checkPrerequisites();
    } else {
      console.log(dim('  Skipping prerequisite checks.\n'));
    }
  }

  // --- Phase 3: Configuration ---
  let envConfig;
  if (isPhaseComplete(state, 'configuration') && state.envConfig && !process.argv.includes('--reconfigure')) {
    if (await confirm('Configuration from a previous run was found. Keep it?', true)) {
      envConfig = state.envConfig;
      // state.mjs redacts auto-generated secrets to the literal string
      // '[REDACTED]' before persisting. If we hand that straight to the
      // platform adapter, services crash-loop on env validation (e.g. Bam
      // apps require SESSION_SECRET ≥ 32 chars). Regenerate any redacted
      // or missing values, merge them back in, and persist so subsequent
      // runs are stable.
      const fresh = generateSecrets();
      const rehydrated = [];
      for (const [key, value] of Object.entries(fresh)) {
        const current = envConfig[key];
        if (!current || current === '[REDACTED]') {
          envConfig[key] = value;
          rehydrated.push(key);
        }
      }
      if (rehydrated.length > 0) {
        console.log(dim(`  Regenerated ${rehydrated.length} secret(s) that were redacted in saved state:`));
        console.log(dim(`    ${rehydrated.join(', ')}`));
        console.log(dim('  (Existing user sessions will be invalidated on next deploy.)'));
        state.envConfig = envConfig;
        saveState(state);
      }
      console.log(`${check} Using saved configuration.\n`);
    } else {
      envConfig = null;
    }
  }

  if (!envConfig) {
    console.log(`\n${bold('Step 3: Configure your deployment')}\n`);

    // Domain — platform-specific prompt + default. The value gets written
    // into CORS_ORIGIN and FRONTEND_URL on every API service, so it needs
    // to match what humans will actually type into a browser to reach the
    // deployed app. For Docker Compose on a laptop, "localhost" is the
    // right answer. For Railway (and any other managed-cloud adapter), the
    // right answer is the public URL you'll eventually point at the
    // frontend/nginx service — even if you don't have it yet, a reasonable
    // placeholder works because Railway lets you edit env vars after deploy.
    const isRailway = platform.name === 'Railway';
    let domain;
    if (isRailway) {
      console.log(dim('  The public URL that humans will use to reach your deployed app.'));
      console.log(dim('  This gets baked into CORS_ORIGIN and FRONTEND_URL on every API service.'));
      console.log('');
      console.log(dim('  Accepted forms:'));
      console.log(dim('    - a custom domain you already own (e.g. bigbluebam.example.com)'));
      console.log(dim('    - a Railway auto-generated subdomain (e.g. bigbluebam.up.railway.app)'));
      console.log(dim('    - a placeholder if you don\'t know yet — you can edit these env vars'));
      console.log(dim('      in the Railway dashboard after you assign the real domain to the'));
      console.log(dim('      frontend service in Step 11 of the runbook.'));
      console.log('');
      console.log(dim('  Enter only the hostname — no "https://", no trailing slash.'));
      console.log('');
      domain = await ask(
        'Public domain for the deployed app:',
        'bigbluebam.example.com',
      );
    } else {
      domain = await ask(
        'Domain name (or "localhost" for local development):',
        'localhost',
      );
    }

    // Generate secrets — but on a `--reconfigure` run against an existing
    // .env, preserve the secrets that bind to *persistent volumes* (postgres
    // role password, redis password, minio root credentials). Postgres only
    // honors POSTGRES_PASSWORD on first init; rolling it via reconfigure
    // breaks every subsequent migrate run with "password authentication
    // failed for user bigbluebam" because the role hash in pg_authid still
    // matches the old password. Same hazard for redis (AUTH on existing
    // RDB/AOF) and minio (root user baked into bucket IAM). Session secrets
    // and INTERNAL_* secrets are safe to reroll — they only invalidate
    // active sessions / require simultaneous service restart, which the
    // deploy script does anyway.
    process.stdout.write('\nGenerating cryptographic secrets... ');
    const secrets = generateSecrets();
    const STORAGE_SECRET_KEYS = [
      'POSTGRES_PASSWORD',
      'REDIS_PASSWORD',
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
    ];
    // .deploy-state.json redacts secrets to '[REDACTED]' before persisting
    // for safety, so we can't preserve from there. The actual source of
    // truth for what the volumes hold is .env on disk — Docker Compose
    // feeds it to postgres/redis/minio at boot. Read .env line-by-line if
    // it exists and overlay the volume-bound keys.
    const preserved = [];
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const text = fs.readFileSync(envPath, 'utf8');
        const map = {};
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
          if (m) map[m[1]] = m[2];
        }
        for (const key of STORAGE_SECRET_KEYS) {
          const existing = map[key];
          if (existing && existing !== '[REDACTED]') {
            secrets[key] = existing;
            preserved.push(key);
          }
        }
      }
    } catch (err) {
      console.log(`\n  ${yellow('!')} Could not read existing .env for secret preservation: ${err.message}`);
    }
    console.log(check);
    if (preserved.length > 0) {
      console.log(dim(`  Preserved ${preserved.length} secret(s) bound to persistent volumes (from .env):`));
      for (const key of preserved) {
        const v = secrets[key];
        // Show first 4 + last 4 chars only — enough to verify against psql
        // / redis-cli without leaking the full secret to a transcript.
        const masked = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})` : `(len=${v.length})`;
        console.log(dim(`    ${key} = ${masked}`));
      }
    } else {
      console.log(dim('  No existing volume-bound secrets to preserve (fresh install).'));
    }

    // Storage
    const storage = await promptStorageChoice();

    // Vector DB
    const vectorDb = await promptVectorDbChoice();

    // LiveKit
    const livekit = await promptLiveKitChoice();

    // Optional integrations
    const integrations = await promptOptionalIntegrations();

    // Root redirect choice
    const rootRedirect = await promptRootRedirect();

    // Advanced port mapping. Only the docker-compose adapter exposes host
    // ports directly to the operator's machine; on Railway the platform
    // routes traffic for us, so the prompt is skipped there. We probe the
    // host first so the "do I need this?" question has a real answer
    // backed by data, not a guess.
    let portMapping = null;
    if (!isRailway) {
      portMapping = await maybeAdvancedPortMapping({
        skipLiveKit: livekit.livekitProvider !== 'livekit-local',
      });
    }

    // Local TLS. Only meaningful for docker-compose (Railway terminates
    // TLS at its edge) and only when useTls was selected — either via the
    // advanced-port-mapping flow or by default for non-localhost domains.
    // See docs/guides/local-ssl-notes.md.
    let tlsConfig = null;
    if (!isRailway) {
      const httpPort = portMapping?.ports?.HTTP_PORT ?? 80;
      const httpsPort = portMapping?.ports?.HTTPS_PORT ?? 443;
      // Default useTls reflects the same scheme inference as
      // public-url.mjs::pickScheme — non-localhost gets https-style URLs
      // and therefore offers TLS provisioning by default.
      const inferredUseTls = portMapping?.useTls ?? (domain && domain !== 'localhost');
      tlsConfig = await promptTlsConfig({
        useTls: inferredUseTls,
        httpPort,
        httpsPort,
        hasOAuth: Boolean(integrations.OAUTH_GOOGLE_CLIENT_ID),
      });
    }

    // Build complete config
    envConfig = buildEnvConfig({
      secrets,
      storage,
      vectorDb,
      livekit,
      integrations,
      domain,
      portMapping,
      tlsConfig,
    });

    // Save to state for resume
    state.envConfig = envConfig;
    state.rootRedirect = rootRedirect;
    state.portMapping = portMapping;
    state.tlsConfig = tlsConfig;
    state.choices = {
      domain,
      storage: storage.storageProvider,
      vectorDb: vectorDb.vectorProvider,
      livekit: livekit.livekitProvider,
      rootRedirect,
      portMapping,
      tlsConfig,
    };
    markPhaseComplete(state, 'configuration');
    saveState(state);

    console.log(`\n${check} Configuration complete.\n`);
  }

  // --- Phase 4: Deploy ---
  // The deploy phase is the only step we can't verify locally. A previous
  // run may have completed deploys that are still happily running on
  // Railway/Docker — OR the operator may have torn everything down outside
  // this script (deleted the Railway project, ran `docker compose down`,
  // wiped a cloud account…). The local `.deploy-state.json` has no way to
  // know. So instead of asserting one or the other, we tell the operator
  // exactly what state we *think* we're in and ask them to confirm.
  let needsFreshDeploy = !isPhaseComplete(state, 'deploy');
  // Tracks whether we're on a "previous services still alive" path. If so,
  // the admin account already exists in the live database from before — we
  // skip the admin creation prompt entirely instead of pestering the operator
  // every update.
  let priorDeploymentPreserved = false;

  if (!needsFreshDeploy) {
    console.log('');
    console.log(`${bold('Step 5: Build and launch')}\n`);
    console.log(dim('  This computer has notes from a previous run that finished the deploy'));
    console.log(dim('  step. We have no way to look at your actual cloud account from here,'));
    console.log(dim('  so we need you to tell us which of these is true right now:'));
    console.log('');
    console.log(`  ${bold('1.')} The services from that previous run are ${bold('still running')} where`);
    console.log(`     you deployed them. (You did not delete the project, you did not run`);
    console.log(`     ${cyan('docker compose down')}, the cloud account is intact, etc.)`);
    console.log('');
    console.log(`  ${bold('2.')} You have ${bold('torn it all down')} since then — deleted the Railway`);
    console.log(`     project, wiped the docker volumes, started fresh, etc. — and you`);
    console.log(`     are installing from scratch right now.`);
    console.log('');
    const stillRunning = await confirm(
      'Are the services from the previous run still running?',
      true,
    );
    if (!stillRunning) {
      // Operator confirmed they tore it all down. Reset the deploy AND
      // admin phases so the normal "build and start everything → create
      // admin" path runs from scratch. The admin user no longer exists in
      // the new deployment, so we have to re-create it too.
      console.log(dim('  Got it — treating this as a fresh install.'));
      console.log('');
      if (state.phases?.deploy) delete state.phases.deploy;
      if (state.phases?.admin) delete state.phases.admin;
      saveState(state);
      needsFreshDeploy = true;
    } else {
      // Services are alive from before — there's already an admin in the
      // live database, whether this script created them on a previous run
      // or the operator did it manually. Don't run admin creation again.
      priorDeploymentPreserved = true;
    }
  }

  if (needsFreshDeploy) {
    if (isPhaseComplete(state, 'configuration')) {
      // We only printed the Step 5 header above when we KNEW a previous
      // deploy phase was recorded. On a true first run we still need to
      // print it before the first deploy.
      console.log(`${bold('Step 5: Build and launch')}\n`);
    }
    if (await confirm('Ready to build and start all services?', true)) {
      const healthy = await platform.deploy(envConfig, { branch, tlsConfig: state.tlsConfig ?? null });
      if (healthy) {
        markPhaseComplete(state, 'deploy');
        saveState(state);
      } else {
        // Deploy returned false — the platform adapter has already printed
        // a detailed error block (with logs, dashboard links, etc.). DO NOT
        // continue to admin creation or print a "ready" summary; that lies
        // to the operator and wastes their time on a doomed admin step.
        console.log('');
        console.log(red(bold('Deployment did not complete successfully.')));
        console.log(dim('  See the error block above for details. Fix the issue (or follow the'));
        console.log(dim('  instructions printed above) and re-run this script — every operation'));
        console.log(dim('  is idempotent, so re-runs pick up where you left off.'));
        console.log('');
        saveState(state);
        return;
      }
    } else {
      console.log(yellow('\nDeployment paused. Re-run this script to continue.\n'));
      return;
    }
  } else {
    console.log('');
    console.log(`${check} ${bold('Your services are still running from a previous run.')}`);
    console.log('');
    console.log(dim('  Right now we are deciding whether to push your current settings to'));
    console.log(dim('  them again and start a fresh deploy.'));
    console.log('');
    console.log(`  ${bold('Pick "yes" if any of these are true:')}`);
    console.log(dim('    • You changed something in the configuration above (a password, a'));
    console.log(dim('      domain, an integration, an API key, etc.)'));
    console.log(dim('    • The script just told you it regenerated secrets a moment ago'));
    console.log(dim('    • The previous deploy failed and you want to try again'));
    console.log(dim('    • You updated the code on GitHub and want the new version live'));
    console.log('');
    console.log(`  ${bold('Pick "no" if:')}`);
    console.log(dim('    • Everything is already working and you just want to skip ahead'));
    console.log(dim('      to the next step (creating your admin account)'));
    console.log('');
    console.log(dim('  Saying "yes" will not delete any data — your database, file uploads,'));
    console.log(dim('  and existing users are safe either way. It just rebuilds and restarts'));
    console.log(dim('  the running services with the latest settings, which takes a few minutes.'));
    console.log('');
    if (await confirm('Push the current settings and redeploy now?', false)) {
      const healthy = await platform.deploy(envConfig, { branch, tlsConfig: state.tlsConfig ?? null });
      if (!healthy) {
        console.log('');
        console.log(red(bold('Redeploy did not complete successfully.')));
        console.log(dim('  See the error block above for details. Your previously running services'));
        console.log(dim('  are unaffected. Fix the issue and re-run this script.'));
        console.log('');
        return;
      }
    } else {
      console.log(dim('  Skipping deployment — your services keep running with their previous settings.\n'));
    }
  }

  // --- Phase 5: Admin account ---
  if (priorDeploymentPreserved && !isPhaseComplete(state, 'admin')) {
    // Operator confirmed the previous deployment is still live, which means
    // an admin already exists in the live database (this script created one
    // on a prior run, OR the operator did it by hand). Mark the phase
    // complete so we don't pester them on every update push, and don't try
    // to run the create-admin command again — it'd just create a noisy
    // duplicate account at best, or fail and waste five minutes of their
    // time at worst.
    console.log('');
    console.log(`${check} Skipping admin creation — your existing deployment already has one.`);
    console.log(dim('  (If you actually need a brand-new admin account, run this script with'));
    console.log(dim('  --reconfigure or create one directly in the running app.)'));
    markPhaseComplete(state, 'admin');
    saveState(state);
  } else if (!isPhaseComplete(state, 'admin')) {
    console.log(`\n${bold('Step 6: Create admin account')}\n`);

    const result = await createSuperUser(platform);
    if (result.deferred) {
      state.adminDeferred = true;
      markPhaseComplete(state, 'admin');
      saveState(state);
      console.log('');
      console.log(`${check} ${bold('Admin account creation deferred.')}`);
      console.log('');
      console.log('  The first visitor to your site will be auto-routed to:');
      console.log(`    ${cyan('/b3/bootstrap')}`);
      console.log('  where they can create the SuperUser account.');
      console.log('');
      console.log(dim('  Send that URL (or your root domain, which will redirect there) to whoever'));
      console.log(dim('  should own the SuperUser account. Once the account exists, the bootstrap'));
      console.log(dim('  page disappears and all routes resolve normally.'));
      console.log('');
    } else if (result.success) {
      state.adminEmail = result.email;
      markPhaseComplete(state, 'admin');
      saveState(state);
    } else {
      // Admin creation failed (most often: Railway CLI not authenticated,
      // not linked to the project, etc.). The createSuperUser helper has
      // already printed the manual fallback command. Offer to mark the
      // phase complete so the operator isn't re-prompted on every future
      // run — they can run the manual command on their own time.
      console.log('');
      const skip = await confirm(
        'Mark admin step as done so this script stops asking on future runs?',
        true,
      );
      if (skip) {
        markPhaseComplete(state, 'admin');
        saveState(state);
        console.log(dim('  Marked done. Remember to run the manual command above before logging in.'));
      }
    }
  } else {
    console.log(`${check} Admin account already created (${dim(state.adminEmail || 'unknown')}).`);
    if (await confirm('Create another admin account?', false)) {
      await createSuperUser(platform);
    }
  }

  // --- Set root redirect if configured ---
  if (state.rootRedirect && state.rootRedirect !== 'site') {
    try {
      process.stdout.write(`Setting root redirect to /${state.rootRedirect}/... `);
      await platform.runCommand('api',
        `node -e "const p=require('postgres');const s=p(process.env.DATABASE_URL);s\\\`UPDATE system_settings SET value='\"${state.rootRedirect}\"' WHERE key='root_redirect'\\\`.then(()=>s.end())"`
      );
      console.log(check);
    } catch {
      console.log(dim('[skipped — you can set this in SuperUser settings]'));
    }
  }

  // --- Phase 6: Summary ---
  const choices = state.choices || {};
  printSummary({
    domain: choices.domain || envConfig.DOMAIN || 'localhost',
    adminEmail: state.adminEmail,
    storage: choices.storage || 'skip',
    vectorDb: choices.vectorDb || 'skip',
    livekit: choices.livekit || 'skip',
    platform: state.platform === 'Docker Compose' ? 'docker-compose' : state.platform,
    portMapping: choices.portMapping || state.portMapping || null,
    tlsConfig: choices.tlsConfig || state.tlsConfig || null,
    baseUrl: envConfig.BASE_URL,
  });

  // Mark everything done
  markPhaseComplete(state, 'complete');
  saveState(state);
}

// Top-level runner.
//
// Node's libuv will assert with `UV_HANDLE_CLOSING` (src\win\async.c:76) if
// the process exits while a readline interface still has pending callbacks.
// That happens when an error is thrown mid-prompt and propagates through
// `main().catch()` directly to `process.exit()`. The fix is to let the
// event loop drain naturally:
//
//   1. Catch any error thrown from main() cleanly.
//   2. Print the message in a friendly red banner, including the `.cause`
//      chain so targeted errors (like the PAT-vs-Project-Token one from
//      railway.mjs::nonPatTokenError) still show their full context.
//   3. Pause stdin so readline's async handle can be collected.
//   4. Set process.exitCode instead of calling process.exit() — Node drains
//      the event loop normally and exits with the right status.
async function runMain() {
  try {
    await main();
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('');
    console.error(red(bold('Deployment interrupted:')));
    console.error(`  ${msg.split('\n').join('\n  ')}`);
    if (err?.cause && err.cause.message && err.cause.message !== msg) {
      console.error(dim(`\n  caused by: ${err.cause.message}`));
    }
    if (process.env.DEBUG && err?.stack) {
      console.error(dim('\n' + err.stack));
    }
    console.error('');
    // Release any readline-held stdin handle so libuv can close cleanly.
    try { process.stdin.pause(); } catch {}
    process.exitCode = 1;
  }
}

runMain();
