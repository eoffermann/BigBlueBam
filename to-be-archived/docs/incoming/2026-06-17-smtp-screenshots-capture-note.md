# SMTP cards: capture notes (task #68 slice)

Two new screenshot recipes were added to `packages/docs-capture/recipes/bam/bam.yaml`:

| recipe id            | doc.order | label                      | route          | identity   |
|----------------------|-----------|----------------------------|----------------|------------|
| `bam-org-smtp`       | 8         | Organization email (SMTP)  | `/b3/settings` | `admin`    |
| `bam-platform-smtp`  | 7         | Platform email (SMTP)      | `/b3/superuser`| `superuser`|

The docs bridge writes them to:
- `docs/apps/bam/screenshots/light/07-platform-smtp.png`
- `docs/apps/bam/screenshots/light/08-org-smtp.png`

(slug = recipe id minus the `bam-` prefix; NN = zero-padded `doc.order`.)
Both are already referenced from `docs/apps/bam/help.md`.

## Org SMTP — captures with the default `admin` identity. No special setup.

`bam-org-smtp` lands on `/b3/settings`, clicks the **Integrations** tab, and
captures the **Organization Email (SMTP)** card. It captured cleanly against the
local stack with the cached `admin` storageState. Run it inside the normal
Gilligan capture pass (`SHOTS_FRESH_LOGIN=1` + a Gilligan-mapped `admin`
identity in `screenshots.config.json`) to get the seeded Gilligan values
(host `smtp.gilligan-travel.example`, from `Gilligan Travel
<noreply@gilligan-travel.example>`).

## Platform SMTP — feasible, but requires a configured `superuser` identity.

The **Platform SMTP relay** card lives in the SuperUser Console → **Platform**
tab and only renders for a SuperUser. The capture engine authenticates as the
recipe `identity` against `env.identities[identity]` (from the gitignored
`screenshots.config.json`) or a cached `apps/e2e/.auth/<identity>.json`. The
default `admin` identity is an ORG admin, not a SuperUser, and `/b3/superuser`
bounces a non-SuperUser back to the dashboard.

This recipe was proven end-to-end against the local stack: with a `superuser`
identity configured pointing at a real SuperUser account, it captured the full
Platform tab with the populated Platform SMTP relay card. To reproduce in a
capture pass:

1. Add a SuperUser identity to `screenshots.config.json` at the repo root:
   ```json
   { "identities": { "superuser": { "email": "<su-email>", "password": "<pw>" } } }
   ```
   pointing at an existing SuperUser (e.g. one created via
   `cli create-admin --superuser`).
2. Run the bam capture pass from the repo root (so the config in cwd is read),
   with `SHOTS_FRESH_LOGIN=1` so it logs in fresh as that identity rather than
   reusing the org-admin storageState.

Two gotchas observed during verification:

- **FTUE tour intercept.** A brand-new SuperUser (just created) is sent into the
  first-login Settings tour and is redirected away from `/b3/superuser`. Use a
  SuperUser that has completed FTUE (i.e. `notification_prefs.ftue_completed =
  true`), which any established account already has. A freshly minted test
  account needs that flag set before it can reach the console.
- If no `superuser` identity is configured, the recipe now **fails its own
  verification gracefully** (auth-skip) instead of crashing the whole batch —
  see the runner change below. So leaving it unconfigured is safe; it just skips.

## Runner change (so an unconfigured identity does not break the batch)

`packages/docs-capture/src/runner.ts` previously authenticated every distinct
identity up front and **threw** on the first unknown one, aborting the entire
batch (including unrelated `admin` recipes). It now records the per-identity auth
error and surfaces it as a normal per-recipe capture failure, so a missing
`superuser` identity only fails `bam-platform-smtp` and every other recipe still
captures. This mirrors how the Helpdesk separate-portal recipes fail verification
rather than aborting when their portal credentials are unset.

## Seed (both levels) — already applied locally, idempotent

`scripts/seed-gilligan/smtp.mjs` seeds dummy, non-deliverable SMTP at both
levels (platform `system_settings.smtp_*` + Gilligan `organizations.settings.smtp`).
All values use the reserved `.example` TLD so nothing can send real mail. The
script header documents the host-side mint/run/revoke sequence for the two
short-lived admin/SuperUser keys it needs (the cast keys in
`scripts/.gilligan-keys.env` are read_write and cannot reach the
admin-scope / SuperUser-gated SMTP routes).
