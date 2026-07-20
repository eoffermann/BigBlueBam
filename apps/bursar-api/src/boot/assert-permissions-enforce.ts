/**
 * Bursar's per-action permission enforcement is an INVARIANT, not a setting.
 *
 * Ported from burn-api/src/boot/assert-permissions-enforce.ts (spec 13.3). Every other
 * service gets `BBB_PERMISSIONS_ENFORCE: ${BBB_PERMISSIONS_ENFORCE:-warn}` in
 * docker-compose.yml, and packages/permissions short-circuits with
 * `if (opts.mode === 'warn') return;` before it can ever deny. Those services survive that
 * because `fastify.requireCan` sits behind a legacy `requireAuth` plus org-role gate.
 *
 * Bursar, like Burn, has no such legacy gate. bursar.spend.read_all, bursar.offer.unseal,
 * bursar.settings.write, and the award-write actions are the only thing standing between an
 * ordinary org member and sealed rival bids, per-vendor spend, and the finding-suppression
 * knobs. A warn-mode bursar-api serves all of it to everyone, silently, at a 100 percent
 * rate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT AN ENV VAR (burn issue #83).
 *
 * `ENV_HINTS` is a flat global name-to-value map with no per-service override
 * (services.mjs declares env as bare name arrays, resolved by name only). A satellite
 * cannot be given a different value than the other services on Railway, so an env-driven
 * assertion would refuse to start and reconcile() would re-clobber any manual fix on every
 * deploy. Since running Bursar unenforced is never correct in ANY environment, the mode is
 * hardcoded at the plugin registration site (BURSAR_PERMISSIONS_MODE below) and
 * BBB_PERMISSIONS_ENFORCE is declared in neither bursar-api's env schema nor its
 * services.mjs catalog block.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The one and only enforcement mode bursar-api may run in. Deliberately a literal constant
 * with no `process.env` read anywhere in its derivation.
 */
export const BURSAR_PERMISSIONS_MODE = 'on' as const;

/**
 * The one and only unresolvable-decision posture bursar-api may run in (burn issue #89).
 *
 * `'on'` mode is NOT by itself fail-closed. packages/permissions returns `'unknown'` when
 * the resolver answers non-2xx, returns a malformed body, or the fetch throws, and the
 * default `onUnknown: 'allow'` passes that straight through to the route handler. Bursar has
 * no legacy requireAuth+role gate behind requireCan, so an apps/api rolling deploy, a crash
 * loop, or a network partition of BBB_API_INTERNAL_URL would serve sealed bids and per-vendor
 * spend to every org member with no 403 and no error. Bursar takes a resolver outage as a
 * 403, never as a grant.
 */
export const BURSAR_PERMISSIONS_ON_UNKNOWN = 'deny' as const;

export class PermissionsEnforcementMisconfiguredError extends Error {
  readonly resolved: string;

  constructor(resolved: string) {
    super(
      `bursar-api resolved permission mode '${resolved}', expected 'on'. ` +
        'Bursar has no legacy requireAuth+role gate behind the permission plugin, so any ' +
        "mode other than 'on' serves sealed rival bids, per-vendor spend, and the " +
        'finding-suppression knobs to every org member. This mode is NOT env-configurable ' +
        'by design (burn issue #83): it is the literal BURSAR_PERMISSIONS_MODE in ' +
        'src/boot/assert-permissions-enforce.ts. If you are seeing this, something ' +
        'reintroduced env-driven configuration. See spec 13.3.',
    );
    this.name = 'PermissionsEnforcementMisconfiguredError';
    this.resolved = resolved;
  }
}

export class PermissionsFailOpenError extends Error {
  readonly resolved: string;

  constructor(resolved: string) {
    super(
      `bursar-api resolved onUnknown '${resolved}', expected 'deny'. ` +
        "Enforcement mode 'on' is not by itself fail-closed: the shared permissions plugin " +
        "returns 'unknown' on a non-2xx resolver response, a malformed body, or a thrown " +
        "fetch, and onUnknown: 'allow' passes that through to the route handler. Bursar has " +
        'no legacy requireAuth+role gate behind requireCan, so an apps/api outage or an ' +
        'unpropagated INTERNAL_SERVICE_SECRET would serve sealed bids and per-vendor spend ' +
        'to every org member. See spec 13.3 and burn issue #89.',
    );
    this.name = 'PermissionsFailOpenError';
    this.resolved = resolved;
  }
}

/**
 * Throws unless the resolved mode is exactly 'on' AND the resolved unresolvable-decision
 * posture is exactly 'deny'. Both halves are required: 'on' alone still passes every request
 * through whenever the resolver is not answering.
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
