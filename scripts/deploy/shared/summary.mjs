// Deployment summary printer — zero dependencies.

import { bold, green, dim, cyan, blue, yellow, check } from './colors.mjs';
import { APP_URLS, SERVICES, INFRASTRUCTURE } from './services.mjs';
import { formatPublicUrl } from './public-url.mjs';

/**
 * Print a formatted deployment summary with URLs, service status, and next steps.
 *
 * @param {{
 *   domain: string,
 *   adminEmail?: string,
 *   storage: string,
 *   vectorDb: string,
 *   livekit: string,
 *   platform: string,
 *   portMapping?: { ports?: Record<string, number>, useTls?: boolean } | null,
 *   baseUrl?: string,
 * }} config
 */
export function printSummary(config) {
  // Prefer the BASE_URL the env was actually built with — guarantees the
  // banner matches CORS_ORIGIN/FRONTEND_URL/HELPDESK_URL on the running
  // services. Fall back to re-deriving for callers that don't pass it.
  const baseUrl = config.baseUrl ?? formatPublicUrl({
    domain: config.domain || 'localhost',
    httpPort: config.portMapping?.ports?.HTTP_PORT ?? 80,
    httpsPort: config.portMapping?.ports?.HTTPS_PORT ?? 443,
    useTls: config.portMapping?.useTls,
  });

  console.log('');
  console.log(green('================================================================'));
  console.log(green('   BigBlueBam is ready!'));
  console.log(green('================================================================'));
  console.log('');

  // App URLs
  console.log(bold('  Your applications:\n'));
  for (const [key, app] of Object.entries(APP_URLS)) {
    console.log(`    ${check} ${app.label.padEnd(30)} ${cyan(baseUrl + app.path)}`);
  }

  console.log('');
  console.log(bold('  Infrastructure:\n'));

  // Core services
  const coreInfra = INFRASTRUCTURE.filter((i) => i.required);
  for (const svc of coreInfra) {
    console.log(`    ${check} ${svc.description.padEnd(30)} ${dim(svc.image)}`);
  }

  // Optional services
  if (config.storage === 'minio') {
    const minio = INFRASTRUCTURE.find((i) => i.name === 'minio');
    console.log(`    ${check} ${minio.description.padEnd(30)} ${dim(minio.image)}`);
  } else if (config.storage === 's3') {
    console.log(`    ${check} ${'File Storage'.padEnd(30)} ${dim('Amazon S3 (external)')}`);
  } else if (config.storage === 'r2') {
    console.log(`    ${check} ${'File Storage'.padEnd(30)} ${dim('Cloudflare R2 (external)')}`);
  } else {
    console.log(`    ${dim('--')} ${'File Storage'.padEnd(30)} ${dim('not configured')}`);
  }

  if (config.vectorDb === 'qdrant-local') {
    const qdrant = INFRASTRUCTURE.find((i) => i.name === 'qdrant');
    console.log(`    ${check} ${qdrant.description.padEnd(30)} ${dim(qdrant.image)}`);
  } else if (config.vectorDb === 'qdrant-cloud') {
    console.log(`    ${check} ${'Vector Search'.padEnd(30)} ${dim('Qdrant Cloud (external)')}`);
  } else {
    console.log(`    ${dim('--')} ${'Vector Search'.padEnd(30)} ${dim('not configured')}`);
  }

  if (config.livekit === 'livekit-local') {
    const lk = INFRASTRUCTURE.find((i) => i.name === 'livekit');
    console.log(`    ${check} ${lk.description.padEnd(30)} ${dim(lk.image)}`);
  } else if (config.livekit === 'livekit-cloud') {
    console.log(`    ${check} ${'Voice/Video'.padEnd(30)} ${dim('LiveKit Cloud (external)')}`);
  } else {
    console.log(`    ${dim('--')} ${'Voice/Video'.padEnd(30)} ${dim('not configured')}`);
  }

  // Port-mapping callout — only when the operator went through the
  // advanced flow and at least one binding ended up on a non-default port.
  // Helps a future operator (or reviewer) understand WHY the URLs above
  // have non-standard ports in them.
  const remappedPorts = config.portMapping?.ports
    ? Object.entries(config.portMapping.ports).filter(([, v]) => typeof v === 'number')
    : [];
  if (remappedPorts.length > 0) {
    console.log('');
    console.log(bold('  Port mapping (advanced):\n'));
    for (const [key, value] of remappedPorts) {
      console.log(`    ${check} ${key.padEnd(30)} ${dim(`host port ${value}`)}`);
    }
  }

  // TLS callout — surfaces the cert source and HTTP-coexistence mode so
  // operators know whether they need to install a CA, expect a cert
  // warning, or watch for the renewal cron entry. See docs/guides/local-ssl-notes.md.
  if (config.tlsConfig) {
    const tls = config.tlsConfig;
    const sourceLabels = {
      'self-signed': 'Self-signed (browser warning expected)',
      'mkcert': 'mkcert (this machine\'s browsers trust automatically)',
      'byo': 'Bring-your-own (operator-provided cert)',
      'letsencrypt': 'Let\'s Encrypt (real public cert with auto-renewal)',
      'reverse-proxy': 'External (TLS terminates at upstream proxy / CDN)',
    };
    const modeLabels = {
      redirect: 'redirect (http → https)',
      both: 'both (http and https serve content)',
      'https-only': 'https-only (http connections dropped)',
      none: 'plain HTTP only (TLS terminates upstream)',
    };
    console.log('');
    console.log(bold('  TLS:\n'));
    console.log(`    ${check} ${'Cert source'.padEnd(30)} ${dim(sourceLabels[tls.source] ?? tls.source)}`);
    console.log(`    ${check} ${'HTTP coexistence'.padEnd(30)} ${dim(modeLabels[tls.httpMode] ?? tls.httpMode)}`);
    if (tls.source === 'letsencrypt') {
      console.log(dim('    (Set up the daily renewal task printed during deploy — see above.)'));
    }
  }

  // Admin account
  console.log('');
  if (config.adminEmail) {
    console.log(bold('  Admin account:\n'));
    console.log(`    Email: ${cyan(config.adminEmail)}`);
    // The SuperUser admin account is in Bam's `users` table. Helpdesk has
    // its own `helpdesk_users` table with separate auth, so the admin
    // password will NOT log into /helpdesk/ — operators self-register
    // there. Always point the admin at /b3/ for first login.
    console.log(`    Login: ${cyan(baseUrl + '/b3/')}`);
  }

  // Next steps
  console.log('');
  console.log(bold('  Next steps:\n'));
  console.log(`    1. Open ${cyan(baseUrl + '/b3/')} in your browser (this is ${bold('Bam')}, the main app)`);
  console.log(`    2. Log in with the admin email and password you just set`);
  console.log(`    3. Create your first project`);
  console.log(`    4. Invite team members from the People page`);
  console.log('');
  console.log(dim(`  Note: ${baseUrl}/helpdesk/ has its own user accounts — your admin`));
  console.log(dim('  password will NOT work there. Helpdesk users register themselves.'));
  console.log('');
  console.log(dim('  Useful commands:'));
  console.log(dim('    View logs:     docker compose logs -f'));
  console.log(dim('    Stop:          docker compose down'));
  console.log(dim('    Restart:       docker compose restart'));
  console.log(dim(`    Reconfigure:   node scripts/deploy/main.mjs`));
  console.log('');

  // Platform-specific notes
  if (config.platform === 'docker-compose') {
    console.log(dim('  Data is stored in Docker volumes. Do NOT run "docker compose down -v"'));
    console.log(dim('  unless you want to wipe everything.'));
    console.log('');
  }
}
