// Local TLS provisioning for the docker-compose deploy flow. Walks the
// operator through choosing one of four cert sources, then mints/copies/
// detects the cert files into ./certs/ before docker-compose brings the
// frontend up. Plugs into the existing useTls boolean from the
// advanced-port-mapping branch — if useTls === false this whole module is
// skipped from main.mjs and no certs are provisioned.
//
// Sharp edges deliberately handled here are catalogued in
// docs/guides/local-ssl-notes.md — read that file before extending or refactoring.
//
// Why not Node's `crypto` for self-signed: node:crypto's X509Certificate
// is a parser, not a generator. node:forge would add a runtime dependency
// to a script that has been zero-dep on principle. openssl is on every
// dev machine that has Docker and on every NAS that runs OpenWRT or DSM.

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ask, askPassword, select, confirm } from './prompt.mjs';
import { bold, dim, check, cyan, yellow, red, green, warn } from './colors.mjs';

/**
 * Cert source enumeration. The deploy script writes the chosen value into
 * the .env as TLS_CERT_SOURCE so the nginx entrypoint can pick the right
 * HSTS aggressiveness (only "letsencrypt" gets the long-lived header).
 */
export const CERT_SOURCES = ['self-signed', 'mkcert', 'byo', 'letsencrypt', 'reverse-proxy'];

/**
 * HTTP-vs-HTTPS coexistence modes. Mirrors what the entrypoint understands.
 */
export const HTTP_MODES = ['redirect', 'both', 'https-only'];

/**
 * Detect whether `mkcert` is available on PATH. POSIX uses `which`,
 * Windows uses `where`. Returns the absolute path or null.
 */
export function detectMkcert() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['mkcert'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // `where` may print multiple paths separated by newlines; first line is
    // the one PATH would resolve to.
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Validate that a cert and key form a matching pair by comparing the
 * modulus of the public key on the cert against the modulus derived from
 * the private key. This is the standard openssl idiom and catches the
 * common BYO mistake of pasting two unrelated PEMs.
 *
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function validateCertKeyPair(certPath, keyPath) {
  for (const p of [certPath, keyPath]) {
    if (!fs.existsSync(p)) return { ok: false, reason: `File not found: ${p}` };
  }
  try {
    const certMd5 = execSync(
      `openssl x509 -noout -modulus -in "${certPath}" | openssl md5`,
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    ).trim();
    const keyMd5 = execSync(
      `openssl rsa -noout -modulus -in "${keyPath}" | openssl md5`,
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    ).trim();
    if (certMd5 !== keyMd5) {
      return { ok: false, reason: `Cert and key do not pair (modulus mismatch).` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `openssl validation failed: ${err.message ?? err}` };
  }
}

/**
 * Self-signed cert generation via openssl. SANs cover the operator's domain
 * plus the always-useful localhost / 127.0.0.1 entries so direct-from-host
 * curl/health probes work too.
 */
export function generateSelfSigned({ domain, certsDir }) {
  fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  const certPath = path.join(certsDir, 'local.crt');
  const keyPath = path.join(certsDir, 'local.key');

  // Build a SAN extension. localhost and 127.0.0.1 are always included so
  // backends that probe the front-end via internal-loopback still work.
  const sanLines = [`DNS.1 = ${domain || 'localhost'}`];
  let dnsCounter = 2;
  if (domain && domain !== 'localhost') sanLines.push(`DNS.${dnsCounter++} = localhost`);
  sanLines.push(`IP.1 = 127.0.0.1`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbb-tls-'));
  const cnfPath = path.join(tmpDir, 'openssl.cnf');
  fs.writeFileSync(cnfPath, [
    '[req]',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[req_distinguished_name]',
    `CN = ${domain || 'localhost'}`,
    '',
    '[v3_req]',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    ...sanLines,
    '',
  ].join('\n'));

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 825 -config "${cnfPath}"`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(certPath, 0o644);
    return { certPath, keyPath };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
}

/**
 * mkcert provisioning. Idempotently runs `mkcert -install` (UAC prompt on
 * Windows the first time) so the local CA is in the trust store, then
 * issues the cert+key into ./certs/.
 */
export function provisionMkcert({ domain, certsDir }) {
  fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  const certPath = path.join(certsDir, 'local.crt');
  const keyPath = path.join(certsDir, 'local.key');

  // mkcert -install is idempotent. On Windows it triggers a UAC prompt the
  // first time only; subsequent runs are silent. On Linux/macOS it adds
  // the rootCA to the system trust store, possibly prompting for sudo.
  execSync('mkcert -install', { stdio: 'inherit' });
  execSync(
    `mkcert -cert-file "${certPath}" -key-file "${keyPath}" "${domain || 'localhost'}" localhost 127.0.0.1`,
    { stdio: 'inherit' },
  );
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  return { certPath, keyPath };
}

/**
 * BYO: copy operator-provided cert+key into ./certs/. Validates pairing
 * before copying so a mismatched pair fails BEFORE nginx tries to load it
 * (nginx's failure on cert/key mismatch is buried in startup logs).
 */
export function provisionByo({ srcCertPath, srcKeyPath, certsDir }) {
  const validation = validateCertKeyPair(srcCertPath, srcKeyPath);
  if (!validation.ok) throw new Error(`BYO cert validation failed: ${validation.reason}`);

  fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  const certPath = path.join(certsDir, 'local.crt');
  const keyPath = path.join(certsDir, 'local.key');
  fs.copyFileSync(srcCertPath, certPath);
  fs.copyFileSync(srcKeyPath, keyPath);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  return { certPath, keyPath };
}

/**
 * Detect whether the operator is running in WSL while Docker Desktop is
 * likely on the Windows host. The cert trust mismatch in this case is a
 * documented mkcert footgun: mkcert installs its rootCA inside WSL's
 * filesystem; Windows browsers won't trust it.
 */
function detectWslWithWindowsDocker() {
  if (process.platform !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

/**
 * Top-level prompt. Returns null when the operator opts out of TLS, or
 * the resolved tlsConfig object when they opted in.
 *
 * @param {object} args
 * @param {boolean} args.useTls - From the advanced-port-mapping flow.
 * @param {number} args.httpPort - From the port-mapping flow.
 * @param {number} args.httpsPort - From the port-mapping flow.
 * @param {boolean} args.hasOAuth - True when OAuth credentials are
 *   already configured (so we can warn about callback-URL allowlists).
 * @returns {Promise<{
 *   source: 'self-signed' | 'mkcert' | 'byo' | 'letsencrypt' | 'reverse-proxy',
 *   httpMode: 'redirect' | 'both' | 'https-only' | 'none',
 *   byo?: { srcCertPath: string, srcKeyPath: string },
 *   letsencrypt?: { domain: string, email: string, agreeTos: true }
 * } | null>}
 */
export async function promptTlsConfig({ useTls, httpPort = 80, httpsPort = 443, hasOAuth = false }) {
  if (!useTls) return null;

  console.log('');
  console.log(bold('TLS / SSL'));
  console.log(dim('  You opted into https-style URLs in the previous step. Pick where TLS'));
  console.log(dim('  is handled — BBB itself (one of four cert sources below) or an upstream'));
  console.log(dim('  layer that already terminates it (reverse proxy, CDN, ingress, etc.).'));
  console.log('');
  console.log(dim('  Pick the first one unless you know better.'));
  console.log('');

  const mkcertPath = detectMkcert();
  const sourceOptions = [
    { label: 'Self-signed (recommended)', value: 'self-signed', description: 'Auto-generated. Browsers warn once per device but TLS works correctly. Zero external setup.' },
    { label: 'Bring your own cert + key', value: 'byo', description: 'You already have a .crt and .key from somewhere (corp PKI, wildcard, etc.). We copy them into place.' },
    { label: mkcertPath ? `mkcert (detected at ${mkcertPath})` : 'mkcert (not installed)', value: 'mkcert', description: mkcertPath ? 'Issues a cert signed by mkcert\'s local CA. THIS machine\'s browsers trust automatically.' : 'mkcert is not on PATH. Install it first or pick another option.' },
    { label: 'Let\'s Encrypt (real public cert)', value: 'letsencrypt', description: 'Auto-issues a real cert via certbot. Requires a public domain pointing at this host with port 80 reachable from the internet.' },
    { label: 'External (reverse proxy / CDN handles TLS)', value: 'reverse-proxy', description: 'BBB stays plain HTTP and URLs declare https://. Pick this when fronted by Cloudflare, Caddy, host nginx, NAS reverse proxy, k8s ingress, etc.' },
  ];

  let source = await select('How is TLS handled for this deployment?', sourceOptions);

  if (source === 'mkcert' && !mkcertPath) {
    console.log(`  ${red('mkcert not on PATH.')} Install it (https://github.com/FiloSottile/mkcert) or pick another option.`);
    source = await select('How is TLS handled for this deployment?', sourceOptions.filter((o) => o.value !== 'mkcert'));
  }

  if (source === 'mkcert' && detectWslWithWindowsDocker()) {
    console.log('');
    console.log(`  ${yellow('Heads up:')} you appear to be running in WSL while Docker Desktop is on the Windows host.`);
    console.log(dim('  mkcert installed in WSL writes its rootCA inside WSL\'s filesystem; your'));
    console.log(dim('  Windows browsers will NOT trust certs it issues. Either install mkcert on'));
    console.log(dim('  Windows directly, or pick self-signed and accept the browser warning.'));
    console.log('');
    if (!(await confirm('Continue with mkcert anyway?', false))) {
      source = await select('How should TLS certs be provisioned?', sourceOptions.filter((o) => o.value !== 'mkcert'));
    }
  }

  // BYO path collection — defer file copy to the provisioning step.
  let byo = null;
  if (source === 'byo') {
    console.log('');
    console.log(dim('  Provide absolute paths to your existing cert and key files.'));
    console.log(dim('  We will validate them with openssl and copy them into ./certs/.'));
    let validation;
    while (true) {
      const srcCertPath = await ask('  Path to certificate (PEM):');
      const srcKeyPath = await ask('  Path to private key (PEM):');
      validation = validateCertKeyPair(srcCertPath, srcKeyPath);
      if (validation.ok) {
        byo = { srcCertPath, srcKeyPath };
        break;
      }
      console.log(`  ${red('Validation failed:')} ${validation.reason}`);
      if (!(await confirm('  Try different paths?', true))) {
        // Operator gave up — fall back to self-signed so we have something to work with.
        console.log(dim('  Falling back to self-signed.'));
        source = 'self-signed';
        break;
      }
    }
  }

  // LE collection — refuse if HTTP_PORT != 80 since LE's HTTP-01 validators
  // always hit public port 80 on the registered hostname. Operator can fix
  // by setting up router-side port forwarding, then re-running.
  let letsencrypt = null;
  if (source === 'letsencrypt') {
    if (httpPort !== 80) {
      console.log('');
      console.log(`  ${red('Let\'s Encrypt cannot work with HTTP_PORT=' + httpPort + '.')}`);
      console.log(dim('  LE\'s HTTP-01 challenge always hits public port 80 on the hostname you'));
      console.log(dim('  register. If your router has port 80 forwarded to this host\'s 8080,'));
      console.log(dim('  set HTTP_PORT back to 80 and re-run. Otherwise pick another cert source.'));
      console.log('');
      const fallbackOptions = sourceOptions.filter((o) => o.value !== 'letsencrypt' && (o.value !== 'mkcert' || mkcertPath));
      source = await select('Pick another cert source:', fallbackOptions);
    } else {
      console.log('');
      console.log(dim('  Let\'s Encrypt issues a real, browser-trusted cert. Renewal is automatic'));
      console.log(dim('  via a host-side cron entry that runs `certbot renew` daily and reloads nginx.'));
      console.log('');
      const domain = await ask('  Public domain (must already resolve to this host):');
      const email = await ask('  Email for renewal notices:');
      console.log(dim('  By proceeding you agree to the Let\'s Encrypt Subscriber Agreement:'));
      console.log(dim('  https://letsencrypt.org/repository/'));
      const agreed = await confirm('  Agree to ToS?', true);
      if (agreed) {
        letsencrypt = { domain, email, agreeTos: true };
      } else {
        const fallbackOptions = sourceOptions.filter((o) => o.value !== 'letsencrypt' && (o.value !== 'mkcert' || mkcertPath));
        source = await select('Pick another cert source:', fallbackOptions);
      }
    }
  }

  // HTTP-vs-HTTPS coexistence prompt (ELI5). Only relevant when BBB itself
  // serves TLS. With the 'reverse-proxy' source the entrypoint always runs
  // plain HTTP on the configured port; the upstream layer owns the redirect
  // / coexistence policy on its side. Pin httpMode='none' here so downstream
  // code (env writing, entrypoint, summary) sees a well-defined value.
  let httpMode;
  if (source === 'reverse-proxy') {
    httpMode = 'none';
  } else {
    console.log('');
    console.log(bold('  HTTP and HTTPS coexistence'));
    console.log(dim('  Once TLS is in place, what should happen when someone visits the plain'));
    console.log(dim('  http:// URL? Three options:'));
    console.log('');
    console.log(`    ${cyan('redirect')}    — http requests bounce to https (recommended)`);
    console.log(dim('                Bookmarks and old links keep working. Cookies stay safe.'));
    console.log(dim('                The right default for any deployment.'));
    console.log('');
    console.log(`    ${cyan('both')}        — http and https BOTH serve the app`);
    console.log(dim('                Useful if you have internal LAN scripts or monitoring tools'));
    console.log(dim('                that hit the app over plain http and you can\'t change them.'));
    console.log(`                ${yellow('Caveat:')} login may silently fail if the user lands on http`);
    console.log(dim('                first — browsers refuse to store the secure session cookie.'));
    console.log('');
    console.log(`    ${cyan('https-only')}  — http requests are dropped (connection close)`);
    console.log(dim('                Strictest posture. Pick this if you actively do not want'));
    console.log(dim('                ANY plain-http traffic, including health probes from a LAN'));
    console.log(dim('                that you control.'));
    console.log('');

    httpMode = await select('Coexistence mode for HTTP and HTTPS?', [
      { label: 'redirect (recommended)', value: 'redirect', description: 'Most deployments want this.' },
      { label: 'both', value: 'both', description: 'Keeps plain http working alongside https.' },
      { label: 'https-only', value: 'https-only', description: 'Drops plain http connections entirely.' },
    ]);
  }

  // OAuth callback warning — only relevant when OAuth is configured AND we're
  // about to switch the scheme. The callback URL allowlisted in the provider
  // console (GitHub, Google, etc.) must match the new scheme exactly.
  if (hasOAuth) {
    console.log('');
    console.log(`  ${yellow('OAuth callback URLs:')}`);
    console.log(dim('  You have OAuth credentials configured. The callback URL allowlisted in'));
    console.log(dim('  the OAuth provider console (GitHub, Google, etc.) must match the new'));
    console.log(dim('  scheme + host + port. After this deploy completes, update the provider'));
    console.log(dim('  console to use the https:// callback URL or your OAuth login will break.'));
    console.log('');
  }

  return {
    source,
    httpMode,
    ...(byo ? { byo } : {}),
    ...(letsencrypt ? { letsencrypt } : {}),
  };
}

/**
 * Provision certs based on the chosen tlsConfig. Called by the
 * docker-compose adapter AFTER .env is written but BEFORE `docker compose
 * up`, so the frontend container's entrypoint sees the certs at boot.
 *
 * Returns `{ certPath, keyPath }` or null when the source is letsencrypt
 * (LE provisioning runs a different path post-up; see letsencrypt.mjs).
 */
export function provisionCerts(tlsConfig, { domain, certsDir }) {
  if (!tlsConfig) return null;
  switch (tlsConfig.source) {
    case 'self-signed':
      return generateSelfSigned({ domain, certsDir });
    case 'mkcert':
      return provisionMkcert({ domain, certsDir });
    case 'byo':
      return provisionByo({
        srcCertPath: tlsConfig.byo.srcCertPath,
        srcKeyPath: tlsConfig.byo.srcKeyPath,
        certsDir,
      });
    case 'letsencrypt':
      // Deferred. The LE flow needs nginx up to serve the ACME challenge,
      // so docker-compose.mjs runs the certbot sidecar after `up`.
      return null;
    case 'reverse-proxy':
      // No certs to provision — an upstream layer terminates TLS. The
      // entrypoint sees TLS_HTTP_MODE=none and keeps nginx on plain HTTP.
      return null;
    default:
      throw new Error(`Unknown TLS cert source: ${tlsConfig.source}`);
  }
}

/**
 * Pick the HSTS header value for a given cert source. Conservative for
 * self-signed/mkcert/byo (avoids permanently poisoning Chrome's HSTS
 * cache for a LAN hostname); long-lived only for LE. Mirrors the logic in
 * infra/nginx/entrypoint.sh — exported here for unit testing.
 */
export function pickHstsHeader(source) {
  if (source === 'letsencrypt') return 'max-age=31536000; includeSubDomains';
  // External-TLS deployments leave HSTS to the upstream proxy/CDN — that's
  // the layer that actually handles TLS, so it's the right place to set the
  // header (and it almost certainly has its own opinions about max-age).
  if (source === 'reverse-proxy') return null;
  return 'max-age=300';
}
