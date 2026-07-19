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

/**
 * Throws PermissionsEnforcementMisconfiguredError unless the resolved mode is exactly
 * 'on'. Pure and synchronous so the unit suite can assert it without booting a server.
 */
export function assertPermissionsEnforcement(resolved: string | undefined): void {
  if (resolved !== 'on') {
    throw new PermissionsEnforcementMisconfiguredError(resolved ?? '<unset>');
  }
}
