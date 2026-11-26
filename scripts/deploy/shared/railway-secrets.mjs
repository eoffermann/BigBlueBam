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

/** Catalog service names that list stable secret `name` (required or optional). */
export function stableSecretHolders(name, services = ALL_SERVICES()) {
  return services.filter((s) => envNames(s).includes(name)).map((s) => s.name);
}

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
  for (const name of sources) {
    const serviceId = liveByName.get(name);
    if (!serviceId) continue;
    let vars;
    try {
      vars = await client.getServiceVariables({ projectId, environmentId, serviceId });
    } catch (err) {
      const message = err?.message ?? String(err);
      readFailures[name] = message;
      log(`  (could not read variables off "${name}": ${message})`);
      continue;
    }
    for (const key of wanted) {
      if (collected[key] === undefined && vars?.[key] !== undefined && vars[key] !== '') {
        collected[key] = vars[key];
      }
    }
  }
  return { collected, readFailures };
}

export class StableSecretUnreadableError extends Error {
  constructor(problems) {
    const lines = problems.map(
      (p) =>
        `${p.secret} (needed by ${p.neededBy}) is held by ${p.unread.join(', ')}, whose variables could not be read: ${p.reasons.join('; ')}`,
    );
    const intro = [
      'Stopping before provisioning: a stable secret could not be read off the live stack, and',
      'making up a new value would leave services with mismatched keys for data that is already',
      'signed or encrypted with the old one.',
    ].join(' ');
    const outro =
      'Nothing was created. Re-run once Railway answers again; if it keeps failing, check that service in the Railway dashboard.';
    super(`${intro}\n  ${lines.join('\n  ')}\n${outro}`);
    this.name = 'StableSecretUnreadableError';
    this.code = 'STABLE_SECRET_UNREADABLE';
    this.problems = problems;
  }
}

/**
 * For every service the catalog says is MISSING on Railway, ensure each of its
 * required secret-kind vars has a value: prefer the shared one copied off the live
 * stack, else GENERATE a fresh 32-byte hex secret (safe only for service-local
 * secrets nothing else references).
 *
 * Stable secrets go through resolveStableSecrets instead, and only after checking
 * that every LIVE catalog holder of that secret was read successfully. If any was
 * not, nothing is generated and StableSecretUnreadableError is thrown, naming the
 * secret. A holder that is not live at all (first provisioning) does not block.
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
      if (!stable.has(name)) continue;
      if (collected[name] !== undefined && collected[name] !== '') continue;
      const unread = stableSecretHolders(name, services).filter(
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
  if (problems.length > 0) throw new StableSecretUnreadableError(problems);

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
