/**
 * Burn's per-action permission enforcement is an INVARIANT, not a setting.
 *
 * Spec 2.4 point 1 / 9.1 (round-2 blocker R2-S1). Every other service in the suite gets
 * `BBB_PERMISSIONS_ENFORCE: ${BBB_PERMISSIONS_ENFORCE:-warn}` in docker-compose.yml, and
 * `packages/permissions/src/index.ts:291` short-circuits with
 * `if (opts.mode === 'warn') return;` before it can ever deny. Those services survive that
 * because `fastify.requireCan` sits behind a legacy `requireAuth` plus org-role gate.
 *
 * Burn is the first app with no such legacy gate. `burn.costrate.read`,
 * `burn.financials.read_all`, `burn.precheck.mark_wrong`, and `burn.settings.write` are the
 * only thing standing between an ordinary org member and per-person compensation,
 * firm-wide profitability, and the gate switch itself. A warn-mode burn-api serves all of
 * it to everyone, silently and at a 100 percent rate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT AN ENV VAR (issue #83).
 *
 * The original design was `BBB_PERMISSIONS_ENFORCE=on` set literally in the burn-api
 * compose block, with a boot assertion on the env value. That works under Docker Compose
 * and CANNOT work on Railway: `ENV_HINTS` is a flat global name-to-value map with no
 * per-service override (`services.mjs` declares env as bare name arrays, and both
 * `buildServiceVariables` and `buildAuthoritativeVariables` resolve by name only). burn-api
 * would receive the global `warn`, the boot assertion would refuse to start the service,
 * and `reconcile()` in `railway-orchestrator.mjs` would re-clobber any manual dashboard fix
 * on every deploy.
 *
 * Since running Burn unenforced is never correct in ANY environment, the mode is hardcoded
 * at the plugin registration site instead (`BURN_PERMISSIONS_MODE` below) and
 * `BBB_PERMISSIONS_ENFORCE` is declared in neither burn-api's env schema nor its
 * `services.mjs` catalog block. The assertion survives, repointed at the RESOLVED plugin
 * mode, so a future refactor that reintroduces env-driven configuration fails loudly at
 * boot rather than silently opening the floors.
 *
 * The second, independent in-route org-role guard on `/v1/cost-rates`,
 * `/v1/financials/accounts`, `/v1/financials/export`, `POST /v1/prechecks/:id/label`, and
 * `PATCH /v1/settings` still stands (spec 2.4 point 1): it reads the role directly off
 * `request.user` and does not route through the resolver, so a resolver outage cannot open
 * those surfaces either.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The one and only enforcement mode burn-api may run in. Deliberately a literal constant
 * with no `process.env` read anywhere in its derivation.
 */
export const BURN_PERMISSIONS_MODE = 'on' as const;

/**
 * The one and only unresolvable-decision posture burn-api may run in (issue #89).
 *
 * `'on'` mode is NOT by itself fail-closed. `packages/permissions/src/index.ts` returns
 * `'unknown'` when the resolver answers non-2xx, returns a malformed body, or the fetch
 * throws, and the default `onUnknown: 'allow'` passes `'unknown'` straight through to the
 * route handler. So the decision table under the default is: deny -> 403, allow -> pass,
 * unknown -> PASS.
 *
 * That default is right for the other 21 satellites, which keep a legacy requireAuth plus
 * org-role gate behind requireCan and degrade to the pre-permissions posture on a resolver
 * outage. It is wrong for Burn, which has no such gate: an apps/api rolling deploy, a crash
 * loop, or a network partition of BBB_API_INTERNAL_URL would serve per-person compensation
 * and firm-wide profitability to every org member, with no 403 and no error, at a 100
 * percent rate. Burn takes a resolver outage as a 403, never as a grant.
 */
export const BURN_PERMISSIONS_ON_UNKNOWN = 'deny' as const;

export class PermissionsEnforcementMisconfiguredError extends Error {
  readonly resolved: string;

  constructor(resolved: string) {
    super(
      `burn-api resolved permission mode '${resolved}', expected 'on'. ` +
        'Burn has no legacy requireAuth+role gate behind the permission plugin, so any ' +
        "mode other than 'on' serves cost rates, margins, and the gate switch to every org " +
        'member. This mode is NOT env-configurable by design (issue #83): it is the ' +
        'literal BURN_PERMISSIONS_MODE in src/boot/assert-permissions-enforce.ts. If you ' +
        'are seeing this, something reintroduced env-driven configuration. See spec 2.4 ' +
        'point 1.',
    );
    this.name = 'PermissionsEnforcementMisconfiguredError';
    this.resolved = resolved;
  }
}

export class PermissionsFailOpenError extends Error {
  readonly resolved: string;

  constructor(resolved: string) {
    super(
      `burn-api resolved onUnknown '${resolved}', expected 'deny'. ` +
        "Enforcement mode 'on' is not by itself fail-closed: the shared permissions " +
        "plugin returns 'unknown' on a non-2xx resolver response, a malformed body, or a " +
        "thrown fetch, and onUnknown: 'allow' passes that through to the route handler. " +
        'Burn has no legacy requireAuth+role gate behind requireCan, so an apps/api ' +
        'outage or an unpropagated INTERNAL_SERVICE_SECRET would serve cost rates and ' +
        'firm-wide financials to every org member. See spec 2.4 point 1 and issue #89.',
    );
    this.name = 'PermissionsFailOpenError';
    this.resolved = resolved;
  }
}

/**
 * Throws unless the resolved mode is exactly 'on' AND the resolved unresolvable-decision
 * posture is exactly 'deny'. Both halves are required: 'on' alone still passes every
 * request through whenever the resolver is not answering.
 *
 * Pure and synchronous so the unit suite can assert it without booting a server.
 */
export function assertPermissionsEnforcement(
  resolved: string | undefined,
  resolvedOnUnknown: string | undefined,
): void {
  if (resolved !== 'on') {
    throw new PermissionsEnforcementMisconfiguredError(resolved ?? '<unset>');
  }
  if (resolvedOnUnknown !== 'deny') {
    throw new PermissionsFailOpenError(resolvedOnUnknown ?? '<unset>');
  }
}
