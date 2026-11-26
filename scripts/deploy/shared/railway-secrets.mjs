// railway-secrets.mjs - shared-secret sourcing for the non-interactive Railway
// reconcile (scripts/deploy/railway-auto-deploy.mjs). Split out so it can be unit
// tested without a token or network (railway-secrets.nodetest.mjs).
//
// Issue #139: a STABLE secret (secrets.mjs) signs or keys durable data, so two
// services holding different values corrupt data silently. The CI path used to
// treat a failed variable read like "no value exists" and mint a fresh one for the
// new service. It now fails closed: when a live service that holds a stable secret
// cannot be read, provisioning a service that needs that secret is aborted with a
// plain message instead, mirroring resolveStableSecrets on the Compose path.
//
// Issue #154: the same rule now covers every SHARED secret-kind variable
// (SESSION_SECRET, INTERNAL_SERVICE_SECRET, MCP_INTERNAL_API_TOKEN, ...). A fresh
// SESSION_SECRET on a new service cannot validate the suite's sessions; a fresh
// INTERNAL_SERVICE_SECRET cannot call or be called by the other services. So a
// secret may be generated only when no live service holds it: every live catalog
// holder is read (not just the preferred sources), and if any of them could not be
// read the run stops instead of guessing.

import { randomBytes } from 'node:crypto';

import { hintFor } from './env-hints.mjs';
import { resolveStableSecrets, stableSecretNames } from './secrets.mjs';
import { APP_SERVICES, INFRA_SERVICES, JOB_SERVICES } from './services.mjs';

const ALL_SERVICES = () => [...APP_SERVICES, ...INFRA_SERVICES, ...JOB_SERVICES];
const envNames = (svc) => [...(svc?.env?.required ?? []), ...(svc?.env?.optional ?? [])];

/** Which env keys are `secret`-kind across the whole catalog. */
export function secretKeyCatalog(services = ALL_SERVICES()) {
  const keys = new Set();
  for (const svc of services) {
    for (const name of envNames(svc)) {
      if (hintFor(name).kind === 'secret') keys.add(name);
    }
  }
  return keys;
}

// The services we prefer to read shared secrets off, in priority order. `api`
// carries SESSION_SECRET + INTERNAL_*; `minio` carries MINIO_*; `livekit`
// carries LIVEKIT_*. First value wins so a shared secret is copied verbatim.
export const SECRET_SOURCE_SERVICES = ['api', 'minio', 'livekit', 'helpdesk-api', 'banter-api'];

/** Catalog service names that list secret `name` (required or optional). */
export function secretHolders(name, services = ALL_SERVICES()) {
  return services.filter((s) => envNames(s).includes(name)).map((s) => s.name);
}

/** Kept for callers from #139; any secret's holders, not only stable ones. */
export const stableSecretHolders = secretHolders;

/**
 * Read shared secret values off the live stack.
 * @returns {Promise<{ collected: Record<string,string>, readFailures: Record<string,string> }>}
 *   readFailures maps a live service name to the error message of its failed read.
 */
export async function collectSharedSecrets(
  client,
  {
    projectId,
    environmentId,
    liveByName,
    log = () => {},
    services = ALL_SERVICES(),
    stableNames = stableSecretNames(),
  },
) {
  const stable = new Set(stableNames);
  const wanted = new Set([...secretKeyCatalog(services), ...stable]);
  const collected = {};
  const readFailures = {};
  // Stable secrets usually live on ONE app service (e.g. bastion-api), not on
  // api/minio, so also read every live service whose catalog entry lists one.
  const stableHolders = services.filter((s) => envNames(s).some((n) => stable.has(n))).map((s) => s.name);
  const sources = [...new Set([...SECRET_SOURCE_SERVICES, ...stableHolders])];
  const attempted = new Set();
  async function readService(name) {
    const serviceId = liveByName.get(name);
    if (!serviceId || attempted.has(name)) return;
    attempted.add(name);
    let vars;
    try {
      vars = await client.getServiceVariables({ projectId, environmentId, serviceId });
    } catch (err) {
      const message = err?.message ?? String(err);
      readFailures[name] = message;
      log(`  (could not read variables off "${name}": ${message})`);
      return;
    }
    for (const key of wanted) {
      if (collected[key] === undefined && vars?.[key] !== undefined && vars[key] !== '') {
        collected[key] = vars[key];
      }
    }
  }
  for (const name of sources) await readService(name);
  // Issue #154: a secret still missing may be held by a live service that is not
  // a preferred source. Read its live holders until one supplies it, so a value
  // is generated later only when no live service holds it.
  for (const key of [...wanted].sort()) {
    for (const holder of secretHolders(key, services)) {
      if (collected[key] !== undefined) break;
      await readService(holder);
    }
  }
  return { collected, readFailures };
}

export class SecretUnreadableError extends Error {
  constructor(problems) {
    const lines = problems.map(
      (p) =>
        `${p.secret} (needed by ${p.neededBy}) is held by ${p.unread.join(', ')}, whose variables could not be read: ${p.reasons.join('; ')}`,
    );
    const intro = [
      'Stopping before provisioning: a secret shared with services that are already running could',
      'not be read off the live stack. Making up a new value would leave the new service unable to',
      'accept the suite\'s sessions or internal calls, or with keys that do not match data already',
      'signed or encrypted with the old value.',
    ].join(' ');
    const outro =
      'Nothing was created. Re-run once Railway answers again; if it keeps failing, check that service in the Railway dashboard.';
    super(`${intro}\n  ${lines.join('\n  ')}\n${outro}`);
    this.name = 'SecretUnreadableError';
    this.code = 'SECRET_UNREADABLE';
    this.problems = problems;
  }
}

/** The #139 name; the rule now covers every shared secret, not only stable ones. */
export const StableSecretUnreadableError = SecretUnreadableError;

/**
 * For every service the catalog says is MISSING on Railway, ensure each of its
 * required secret-kind vars has a value: prefer the shared one copied off the live
 * stack, else GENERATE a fresh 32-byte hex secret.
 *
 * Generation is allowed only when no live service holds the secret. For every
 * secret-kind or stable name (issue #154 extended the #139 rule from stable to
 * shared secrets), every LIVE catalog holder must have been read successfully; if
 * any was not, nothing is generated and SecretUnreadableError is thrown, naming
 * the secret. A holder that is not live at all (first provisioning) does not block.
 * Stable secrets are then filled through resolveStableSecrets.
 *
 * Mutates `collected`; returns the list of generated "NAME (for svc)" labels.
 */
export function fillMissingSecrets(
  collected,
  missingServices,
  {
    readFailures = {},
    liveByName = new Map(),
    services = ALL_SERVICES(),
    stableNames = stableSecretNames(),
    generate,
  } = {},
) {
  const stable = new Set(stableNames);

  // Pass 1: fail closed before generating anything.
  const problems = [];
  for (const svc of missingServices) {
    for (const name of svc.env?.required ?? []) {
      if (!stable.has(name) && hintFor(name).kind !== 'secret') continue;
      if (collected[name] !== undefined && collected[name] !== '') continue;
      const unread = secretHolders(name, services).filter(
        (h) => liveByName.has(h) && Object.prototype.hasOwnProperty.call(readFailures, h),
      );
      if (unread.length > 0) {
        problems.push({
          secret: name,
          neededBy: svc.name,
          unread,
          reasons: unread.map((h) => `${h}: ${readFailures[h]}`),
        });
      }
    }
  }
  if (problems.length > 0) throw new SecretUnreadableError(problems);

  // Pass 2: fill.
  const generated = [];
  for (const svc of missingServices) {
    for (const name of svc.env?.required ?? []) {
      if (!stable.has(name) && hintFor(name).kind !== 'secret') continue;
      if (collected[name] !== undefined && collected[name] !== '') continue;
      if (stable.has(name)) {
        const r = resolveStableSecrets({
          names: [name],
          live: collected,
          ...(generate ? { generate } : {}),
        });
        collected[name] = r.values[name];
      } else {
        collected[name] = generate ? generate(name) : randomBytes(32).toString('hex');
      }
      generated.push(`${name} (for ${svc.name})`);
    }
  }
  return generated;
}
