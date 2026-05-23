// Secret generation and integration configuration prompts.
// Zero dependencies (node:crypto only, plus local prompt helpers).

import * as crypto from 'node:crypto';
import { ask, askPassword, select, confirm } from './prompt.mjs';
import { bold, dim, check, green, yellow, cyan } from './colors.mjs';
import { formatPublicUrl } from './public-url.mjs';

/**
 * Generate a cryptographically random hex string.
 */
function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate all required secrets automatically.
 */
export function generateSecrets() {
  return {
    SESSION_SECRET: randomHex(32),
    INTERNAL_HELPDESK_SECRET: randomHex(32),
    INTERNAL_SERVICE_SECRET: randomHex(32),
    MINIO_ROOT_USER: 'bigbluebam',
    MINIO_ROOT_PASSWORD: randomHex(24),
    POSTGRES_PASSWORD: randomHex(24),
    REDIS_PASSWORD: randomHex(24),
    LIVEKIT_API_KEY: 'API' + randomHex(16),
    LIVEKIT_API_SECRET: randomHex(32),
  };
}

/**
 * Prompt user for file storage choice.
 */
export async function promptStorageChoice() {
  const choice = await select('How should BigBlueBam store uploaded files?', [
    { label: 'Built-in storage (MinIO)', value: 'minio', description: 'Simplest -- included in the install' },
    { label: 'Amazon S3', value: 's3', description: "You'll need an AWS account and S3 bucket" },
    { label: 'Cloudflare R2', value: 'r2', description: "You'll need a Cloudflare account" },
    { label: 'Skip for now', value: 'skip', description: "File uploads won't work" },
  ]);

  const config = { storageProvider: choice };

  if (choice === 's3') {
    console.log(`\n${bold('Amazon S3 Configuration')}\n`);
    config.S3_ENDPOINT = await ask('S3 endpoint (leave blank for default AWS):', '');
    config.S3_ACCESS_KEY = await ask('Access key ID:');
    config.S3_SECRET_KEY = await askPassword('Secret access key:');
    config.S3_BUCKET = await ask('Bucket name:', 'bigbluebam-uploads');
    config.S3_REGION = await ask('Region:', 'us-east-1');
  } else if (choice === 'r2') {
    console.log(`\n${bold('Cloudflare R2 Configuration')}\n`);
    config.S3_ENDPOINT = await ask('R2 endpoint URL:');
    config.S3_ACCESS_KEY = await ask('Access key ID:');
    config.S3_SECRET_KEY = await askPassword('Secret access key:');
    config.S3_BUCKET = await ask('Bucket name:', 'bigbluebam-uploads');
    config.S3_REGION = await ask('Region:', 'auto');
  }

  return config;
}

/**
 * Prompt user for vector DB choice (Qdrant).
 */
export async function promptVectorDbChoice() {
  const choice = await select('Vector search for Beacon knowledge base:', [
    { label: 'Built-in Qdrant', value: 'qdrant-local', description: 'Self-hosted, included in the install' },
    { label: 'Qdrant Cloud', value: 'qdrant-cloud', description: "You'll need a Qdrant Cloud account" },
    { label: 'Skip for now', value: 'skip', description: 'Beacon semantic search will be disabled' },
  ]);

  const config = { vectorProvider: choice };

  if (choice === 'qdrant-cloud') {
    console.log(`\n${bold('Qdrant Cloud Configuration')}\n`);
    config.QDRANT_URL = await ask('Qdrant cluster URL:');
    config.QDRANT_API_KEY = await askPassword('API key:');
  }

  return config;
}

/**
 * Prompt user for LiveKit choice.
 */
export async function promptLiveKitChoice() {
  const choice = await select('Voice/video calling (LiveKit):', [
    { label: 'Built-in LiveKit', value: 'livekit-local', description: 'Self-hosted, included in the install' },
    { label: 'LiveKit Cloud', value: 'livekit-cloud', description: "You'll need a LiveKit Cloud account" },
    { label: 'Skip for now', value: 'skip', description: 'Voice/video features will be disabled' },
  ]);

  const config = { livekitProvider: choice };

  if (choice === 'livekit-cloud') {
    console.log(`\n${bold('LiveKit Cloud Configuration')}\n`);
    config.LIVEKIT_URL = await ask('LiveKit server URL:');
    config.LIVEKIT_API_KEY = await ask('API key:');
    config.LIVEKIT_API_SECRET = await askPassword('API secret:');
  }

  return config;
}

/**
 * Prompt for optional integrations.
 *
 * Historical note: earlier versions of this function also asked about
 * Google OAuth (OAUTH_GOOGLE_CLIENT_ID/SECRET) and AI provider keys
 * (OPENAI_API_KEY/ANTHROPIC_API_KEY). Both were removed:
 *
 *   - Google OAuth SSO is not yet implemented in the auth layer. Nothing
 *     in apps/api/src/ consumes OAUTH_GOOGLE_* env vars, so the prompt
 *     was writing values that no service reads. If/when SSO lands, re-add
 *     the prompt here (or — better — let operators configure it from a
 *     SuperUser settings page, same pattern as SMTP below).
 *
 *   - AI/LLM provider keys are managed in-app via the LLM Providers page
 *     (apps/frontend/src/pages/settings-llm-providers.tsx, backed by
 *     apps/api/src/routes/llm-provider.routes.ts). Operators create
 *     provider records at runtime with test-connection support; the
 *     deploy-script prompt was writing env vars that no service reads.
 *     The in-app flow is strictly better than the deploy-time prompt.
 *
 * What remains here: SMTP. The SMTP config is ALSO editable from a
 * SuperUser settings page (apps/frontend/src/components/settings/
 * smtp-settings-form.tsx), backed by the system_settings table. The
 * worker's email jobs resolve config DB-first, env-fallback (see
 * apps/worker/src/utils/smtp-config.ts). Operators can pick either
 * path — fill it in here at deploy time, or skip and configure later
 * in the app. We call that out in the prompt text.
 */
export async function promptOptionalIntegrations() {
  const config = {};

  console.log(`\n${bold('Optional Integrations')}`);
  console.log(dim('Everything in this section can also be configured later as a SuperUser'));
  console.log(dim('from inside the app (Settings → Integrations). Skip anything you\'d rather'));
  console.log(dim('set up after the deploy finishes — no need to know your SMTP creds now.\n'));

  // SMTP — also editable at runtime via the SuperUser Settings → Email form
  if (await confirm('Configure email (SMTP) for notifications now?', false)) {
    console.log(`\n${bold('SMTP Configuration')}`);
    console.log(dim('You can change any of these later from Settings → Integrations → Email\n'));
    config.SMTP_HOST = await ask('SMTP host:', 'smtp.gmail.com');
    config.SMTP_PORT = await ask('SMTP port:', '587');
    config.SMTP_USER = await ask('SMTP username/email:');
    config.SMTP_PASS = await askPassword('SMTP password:');
    config.SMTP_FROM = await ask('From address:', config.SMTP_USER || '');
    console.log(`  ${check} SMTP configured`);
  } else {
    console.log(`  ${dim('Skipped SMTP — configure it later at Settings → Integrations → Email')}`);
    console.log(`  ${dim('(Sign in as a SuperUser after the deploy completes.)')}`);
  }

  return config;
}

/**
 * Ask the user what the root domain (/) should show.
 */
export async function promptRootRedirect() {
  console.log(`\n${bold('Homepage')}`);
  console.log(dim('When someone visits your domain root (/), where should they land?\n'));

  const choice = await select('Root page:', [
    { label: 'Marketing Site — product overview, screenshots, documentation', value: 'site' },
    { label: 'Bam — project management board (most common for internal teams)', value: 'b3' },
    { label: 'Helpdesk — customer support portal (for customer-facing deploys)', value: 'helpdesk' },
    { label: 'Beacon — knowledge base', value: 'beacon' },
    { label: 'Brief — collaborative documents', value: 'brief' },
    { label: 'Bolt — workflow automations', value: 'bolt' },
    { label: 'Bearing — goals & OKR tracking', value: 'bearing' },
    { label: 'Board — visual collaboration', value: 'board' },
    { label: 'Banter — team messaging', value: 'banter' },
  ]);

  console.log(`  ${check} Root will show: ${choice === 'site' ? 'Marketing Site' : '/' + choice + '/'}`);
  console.log(dim('  You can change this later in SuperUser settings.\n'));

  return choice;
}

/**
 * Build a complete env config object from all collected choices.
 */
export function buildEnvConfig(choices) {
  const { secrets, storage, vectorDb, livekit, integrations, domain, portMapping, tlsConfig } = choices;

  // Port mapping — null/undefined means "use the laptop defaults". The
  // advanced-port-mapping flow returns { ports: { HTTP_PORT, HTTPS_PORT,
  // LIVEKIT_RTC_PORT, LIVEKIT_TCP_PORT }, useTls } when the operator
  // walked through it.
  const httpPort = portMapping?.ports?.HTTP_PORT ?? 80;
  const httpsPort = portMapping?.ports?.HTTPS_PORT ?? 443;
  // useTls promotes to true whenever a TLS cert source was chosen, even if
  // the original port-mapping flow didn't ask. This keeps URL formation
  // honest with the actual nginx posture.
  const effectiveUseTls = tlsConfig != null ? true : portMapping?.useTls;
  const baseUrl = formatPublicUrl({
    domain: domain || 'localhost',
    httpPort,
    httpsPort,
    useTls: effectiveUseTls,
  });

  const env = {
    // Domain
    DOMAIN: domain || 'localhost',
    BASE_URL: baseUrl,
    // Echoed into every API service's CORS_ORIGIN and FRONTEND_URL so the
    // browser-side origin (which always includes the actual host port the
    // user typed) matches what the API checks against. The launchpad
    // resolver, login cookie path, and helpdesk routing all derive from
    // these.
    CORS_ORIGIN: baseUrl,
    FRONTEND_URL: `${baseUrl}/b3`,
    HELPDESK_URL: `${baseUrl}/helpdesk`,
    PUBLIC_URL: baseUrl,
    TRACKING_BASE_URL: `${baseUrl}/t`,

    // Database
    POSTGRES_USER: 'bigbluebam',
    POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD,
    POSTGRES_DB: 'bigbluebam',
    DATABASE_URL: `postgresql://bigbluebam:${secrets.POSTGRES_PASSWORD}@postgres:5432/bigbluebam`,

    // Redis
    REDIS_PASSWORD: secrets.REDIS_PASSWORD,
    REDIS_URL: `redis://:${secrets.REDIS_PASSWORD}@redis:6379`,

    // Sessions
    SESSION_SECRET: secrets.SESSION_SECRET,
    INTERNAL_HELPDESK_SECRET: secrets.INTERNAL_HELPDESK_SECRET,
    INTERNAL_SERVICE_SECRET: secrets.INTERNAL_SERVICE_SECRET,

    // Node environment
    NODE_ENV: 'production',
  };

  // Storage
  if (storage.storageProvider === 'minio') {
    env.MINIO_ROOT_USER = secrets.MINIO_ROOT_USER;
    env.MINIO_ROOT_PASSWORD = secrets.MINIO_ROOT_PASSWORD;
    env.S3_ENDPOINT = 'http://minio:9000';
    env.S3_ACCESS_KEY = secrets.MINIO_ROOT_USER;
    env.S3_SECRET_KEY = secrets.MINIO_ROOT_PASSWORD;
    env.S3_BUCKET = 'bigbluebam-uploads';
    env.S3_REGION = 'us-east-1';
    env.S3_FORCE_PATH_STYLE = 'true';
  } else if (storage.storageProvider === 's3' || storage.storageProvider === 'r2') {
    if (storage.S3_ENDPOINT) env.S3_ENDPOINT = storage.S3_ENDPOINT;
    env.S3_ACCESS_KEY = storage.S3_ACCESS_KEY;
    env.S3_SECRET_KEY = storage.S3_SECRET_KEY;
    env.S3_BUCKET = storage.S3_BUCKET;
    env.S3_REGION = storage.S3_REGION;
  }

  // Vector DB
  if (vectorDb.vectorProvider === 'qdrant-local') {
    env.QDRANT_URL = 'http://qdrant:6333';
  } else if (vectorDb.vectorProvider === 'qdrant-cloud') {
    env.QDRANT_URL = vectorDb.QDRANT_URL;
    env.QDRANT_API_KEY = vectorDb.QDRANT_API_KEY;
  }

  // LiveKit
  if (livekit.livekitProvider === 'livekit-local') {
    env.LIVEKIT_URL = 'ws://livekit:7880';
    env.LIVEKIT_API_KEY = secrets.LIVEKIT_API_KEY;
    env.LIVEKIT_API_SECRET = secrets.LIVEKIT_API_SECRET;
  } else if (livekit.livekitProvider === 'livekit-cloud') {
    env.LIVEKIT_URL = livekit.LIVEKIT_URL;
    env.LIVEKIT_API_KEY = livekit.LIVEKIT_API_KEY;
    env.LIVEKIT_API_SECRET = livekit.LIVEKIT_API_SECRET;
  }

  // Integrations
  const intKeys = [
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  ];
  for (const key of intKeys) {
    if (integrations[key]) env[key] = integrations[key];
  }

  // Advanced port mapping (only when the operator opted in). Each is
  // emitted as a top-level .env var; docker-compose.yml interpolates them
  // via ${HTTP_PORT:-80}, ${LIVEKIT_RTC_PORT:-7880}, etc. We only emit
  // values that differ from the upstream default to keep the .env file
  // small and to make "what did I customize?" obvious to a future reader.
  const PORT_DEFAULTS = {
    HTTP_PORT: 80,
    HTTPS_PORT: 443,
    LIVEKIT_RTC_PORT: 7880,
    LIVEKIT_TCP_PORT: 7881,
  };
  if (portMapping?.ports) {
    for (const [key, value] of Object.entries(portMapping.ports)) {
      if (typeof value === 'number' && value !== PORT_DEFAULTS[key]) {
        env[key] = String(value);
      }
    }
  }

  // Local TLS. When the operator opted in, the entrypoint renders nginx
  // with TLS placeholders enabled and every API service receives
  // COOKIE_SECURE=true so session cookies carry the Secure flag. The
  // single COOKIE_SECURE line closes 14 audit findings (BAM-045, BOLT-011,
  // BRF-020, etc.) since most satellite APIs default this to false.
  if (tlsConfig) {
    env.TLS_CERT_SOURCE = tlsConfig.source;
    env.TLS_HTTP_MODE = tlsConfig.httpMode;
    env.EXT_HTTPS_PORT = String(httpsPort);
    env.COOKIE_SECURE = 'true';
    if (tlsConfig.letsencrypt) {
      env.LETSENCRYPT_DOMAIN = tlsConfig.letsencrypt.domain;
      env.LETSENCRYPT_EMAIL = tlsConfig.letsencrypt.email;
      env.LETSENCRYPT_AGREE_TOS = tlsConfig.letsencrypt.agreeTos ? 'true' : 'false';
    }
  } else {
    // HTTP-only deploy (no TLS). Must pin COOKIE_SECURE=false explicitly:
    // apps/api/src/env.ts defaults it to true when NODE_ENV=production, which
    // makes browsers silently drop the Set-Cookie over plain HTTP and every
    // post-login request 401s. See BAM-010.
    env.COOKIE_SECURE = 'false';
  }

  return env;
}
