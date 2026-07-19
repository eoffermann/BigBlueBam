#!/usr/bin/env node
/**
 * check-env-hints.mjs - coverage guard for the Railway env-hints map.
 *
 * Asserts that EVERY variable named in any APP_SERVICES[].env.required or
 * APP_SERVICES[].env.optional list in scripts/deploy/shared/services.mjs
 * resolves to a known hint in scripts/deploy/shared/env-hints.mjs.
 *
 * Why this guard exists
 * ---------------------
 * hintFor() returns { kind: 'unknown' } for anything it has never heard of, and
 * buildServiceVariables() in railway-orchestrator.mjs treats `unknown` as SKIP.
 * That produces two silent, quite different failures:
 *
 *   - OPTIONAL var with no hint: omitted from the Railway service entirely. The
 *     inter-service integration it configures is simply absent in production and
 *     nothing anywhere reports it. This is how services shipped without their
 *     Bolt event-publishing URL set.
 *
 *   - REQUIRED var with no hint: buildServiceVariables THROWS, aborting the whole
 *     Railway provisioning run for that service.
 *
 * Adding a var to the catalog and forgetting the hint is the easiest possible
 * mistake to make, and neither outcome points at env-hints.mjs. This guard turns
 * both into a CI failure that names the variable and the services that want it.
 *
 * Run via:  node scripts/check-env-hints.mjs   (or `pnpm check:env-hints`)
 *
 * Exit codes:
 *   0 - every catalog variable has a hint (modulo the frozen allowlist below)
 *   1 - one or more variables have no hint, or the allowlist has gone stale
 */

import { APP_SERVICES } from './deploy/shared/services.mjs';
import { hintFor, PLANNED_APP_SERVICES} from './deploy/shared/env-hints.mjs';

/**
 * ── FROZEN ALLOWLIST - APPEND FORBIDDEN ──────────────────────────────────────
 *
 * Dated 2026-07-19. These are the pre-existing variables that had no env-hints
 * entry at the moment this guard was introduced. They are grandfathered ONLY so
 * the guard could be landed green rather than being landed disabled.
 *
 * THIS LIST MAY ONLY SHRINK. Do not append to it.
 *
 * A new entry here means a newly-added variable will be silently dropped from
 * production, which is precisely the failure this guard exists to prevent. If
 * you are adding a variable to services.mjs, add its hint to env-hints.mjs; if
 * you genuinely believe it cannot have one, that is a design discussion to have
 * in review, not a line to add here. New entries fail review.
 *
 * To remove an entry: add the real hint to env-hints.mjs and delete the line.
 * Every deletion is a strict improvement and needs no justification.
 *
 * Deliberately NOT in this list, having been FIXED rather than grandfathered:
 *   - BOLT_API_INTERNAL_URL   was `required` on bulwark-api and hard-aborting
 *                             that service's provisioning (a live bug).
 *   - BRAID_API_INTERNAL_URL  optional on bolt-api, bulwark-api, and worker, so
 *                             Braid resolution was silently absent in prod.
 * Both now have computed hints, along with six further names Burn needs
 * (BILL_API_INTERNAL_URL, BURN_API_INTERNAL_URL, BURN_API_URL,
 * BBB_PERMISSIONS_ENFORCE, MAX_DOC_BYTES, MAX_DOC_PAGES), which were latent
 * rather than live because nothing in the catalog references them yet.
 */
const PRE_EXISTING_UNHINTED = new Set([
  'BASIS_API_URL',
  'BENCH_API_INTERNAL_URL',
  'BIN_SECRETS_KEY',
  'BIN_SECRETS_KEY_ID',
  'BLAST_API_INTERNAL_URL',
  'BLIP_API_URL',
  'BOARD_INTERNAL_URL',
  'BOOK_INTERNAL_URL',
  'BRAID_API_URL',
  'BRIEF_INTERNAL_URL',
  'BULWARK_API_INTERNAL_URL',
  'BULWARK_API_URL',
  'EXPLANATION_CACHE_TTL_SECONDS',
  'LLM_TIMEOUT_MS',
  'UPLOAD_MAX_FILE_SIZE',
]);

/** Collect every (varName -> ["service:required", ...]) pair from the catalog. */
function collectCatalogVars() {
  const seen = new Map();
  for (const service of APP_SERVICES) {
    for (const kind of ['required', 'optional']) {
      for (const name of service.env?.[kind] ?? []) {
        if (!seen.has(name)) seen.set(name, []);
        seen.get(name).push(`${service.name}:${kind}`);
      }
    }
  }
  return seen;
}

function main() {
  const catalogVars = collectCatalogVars();

  const unhinted = new Map();
  for (const [name, usedBy] of catalogVars) {
    if (hintFor(name).kind === 'unknown') unhinted.set(name, usedBy);
  }

  // 1. Anything unhinted that is NOT grandfathered is a hard failure.
  const violations = [...unhinted].filter(([name]) => !PRE_EXISTING_UNHINTED.has(name));

  // 2. The allowlist must not go stale. An entry that now HAS a hint, or that is
  //    no longer referenced by the catalog at all, must be deleted so the list
  //    keeps shrinking and never quietly grants cover to a future variable that
  //    happens to reuse the name.
  const staleAllowlist = [...PRE_EXISTING_UNHINTED].filter((name) => !unhinted.has(name));

  if (violations.length === 0 && staleAllowlist.length === 0) {
    console.log(
      `env-hints coverage OK: ${catalogVars.size} catalog variables checked, ` +
        `${PRE_EXISTING_UNHINTED.size} grandfathered.`,
    );
    return 0;
  }

  if (violations.length > 0) {
    console.error(
      `\nenv-hints coverage FAILED: ${violations.length} variable(s) in services.mjs have no hint.\n`,
    );
    for (const [name, usedBy] of violations.sort()) {
      const isRequired = usedBy.some((u) => u.endsWith(':required'));
      const impact = isRequired
        ? 'REQUIRED somewhere -> Railway provisioning will THROW for that service'
        : 'optional -> silently omitted in production, no signal';
      console.error(`  ${name}`);
      console.error(`      used by: ${usedBy.join(', ')}`);
      console.error(`      impact:  ${impact}`);
    }
    console.error(
      '\nFix: add an entry for each to ENV_HINTS in scripts/deploy/shared/env-hints.mjs.',
    );
    console.error('Do NOT add it to PRE_EXISTING_UNHINTED - that list is append-forbidden.\n');
  }

  if (staleAllowlist.length > 0) {
    console.error(
      `\nenv-hints allowlist STALE: ${staleAllowlist.length} entry(ies) are no longer needed.\n`,
    );
    for (const name of staleAllowlist.sort()) {
      const reason = catalogVars.has(name)
        ? 'now has a hint'
        : 'no longer referenced by any service in the catalog';
      console.error(`  ${name}  (${reason})`);
    }
    console.error(
      '\nFix: delete these from PRE_EXISTING_UNHINTED in scripts/check-env-hints.mjs.\n',
    );
  }

  return 1;
}

process.exit(main());

// A planned service that has since landed in APP_SERVICES must be removed from
// PLANNED_APP_SERVICES, otherwise plannedApp() keeps hand-rolling a URL that internal()
// should now own. Shrink-only, same discipline as the grandfathered allowlist.
const stalePlanned = [...PLANNED_APP_SERVICES].filter((n) => APP_SERVICES.some((s) => s.name === n));
if (stalePlanned.length) {
  console.error(
    `
PLANNED_APP_SERVICES is stale: ${stalePlanned.join(', ')} now exist(s) in APP_SERVICES.
` +
      `Remove them from PLANNED_APP_SERVICES in scripts/deploy/shared/env-hints.mjs so
` +
      `internal() resolves them and the typo guard stays meaningful.
`,
  );
  process.exitCode = 1;
}
