# Invite, password-reset, and onboarding loop

Living notes on how member invitations, admin-issued password resets,
and self-serve forgot-password tie together end-to-end. Written
2026-06-11 after diagnosing the "invite email links to login page"
incident.

## The challenge

The user reported: "The invite email doesn't actually let the person log
in. It just links them to the login page." The SMTP test button was
green; emails arrived; but the link inside an invitation email landed
the invitee on a generic page that gave them no way to set their
password — they could only navigate to a login page that wouldn't
accept any credentials because they'd never set any.

## The flow, as it actually works

1. **Admin clicks "Invite member"** in the SuperUser → People / org People
   page. The frontend posts to `POST /b3/api/org/members/invite`.

2. **The api creates the user.** `orgService.inviteMember` inserts a row
   in `users` with `password_hash = NULL` and an `organization_memberships`
   row with the new org. No password is set at this stage.

3. **The api mints an onboarding token** via
   `passwordResetService.mintToken({ purpose: 'invite', ttlMinutes: 60*24*7 })`.
   A 32-byte random value is generated; only its SHA-256 hash is stored
   in `password_reset_tokens`. The raw token lives just long enough to
   be put in the URL.

4. **The api enqueues `sendMemberInvitationEmail`** with `isNewUser: true`
   and the raw `onboardingToken`. The function (in
   `apps/api/src/lib/email-queue.ts`) builds the link as:

   ```
   const setupUrl = `${spaBase()}/password-reset?token=${encodeURIComponent(onboardingToken)}`;
   ```

5. **The worker delivers the message** via the SMTP transport resolved by
   the shared `@bigbluebam/smtp-resolver`.

6. **The invitee clicks the link.** The SPA route handler in
   `apps/frontend/src/App.tsx` recognizes `/password-reset?token=…`,
   renders `<PasswordResetPage>` with the token in URL state. The page
   shows a "Set a new password" form.

7. **The invitee submits a new password.** The form posts to
   `POST /b3/api/auth/password-reset/consume` with `{ token, new_password }`.
   `passwordResetService.consumeToken` validates the token (not expired,
   not used, exists), hashes the new password with argon2id, writes
   `password_hash` to the user row, stamps `used_at` on the token row,
   and deletes every session for the user (defensive against a stolen
   cookie outliving the password it was issued under).

8. **The invitee is shown a success screen** ("Welcome to BigBlueBam.
   Your password is set. You can now log in.") with a "Go to login"
   button that takes them to the normal login form. They log in and
   land on the dashboard.

The admin-issued password reset (`POST /org/members/:id/reset-password`)
and the self-serve forgot-password (`POST /auth/password-reset/request`)
follow the same shape from step 3 onward — they just use
`purpose: 'reset'` and shorter TTLs.

## What actually broke

The failure was at **step 4**. The link was built as:

```ts
const setupUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/password-reset?token=…`;
```

On a deployment where `FRONTEND_URL` was configured as the site root
(`https://bigbluebam.com`) rather than the Bam SPA mount point
(`https://bigbluebam.com/b3`), the link became:

```
https://bigbluebam.com/password-reset?token=…
```

That URL is served by nginx, which has `location /b3/` for the Bam SPA
but no `/password-reset` location of its own — so it falls through to
the marketing site catch-all at `location /`. The marketing site's
React app (`site/src/app.tsx`) has its own router and shows the home
page for any path it doesn't recognize. The user sees the marketing
home, clicks "Sign in" in the navbar, lands on the login form, can't
log in. There's no path from there to a token-bearing password-reset
page.

The local dev stack works because the default `FRONTEND_URL`
(`http://localhost/b3`) already includes the `/b3` suffix, so the
generated link is correct.

## The fix

Two layers, so the loop is robust regardless of how a future deployer
sets `FRONTEND_URL`:

1. **`apps/api/src/lib/urls.ts` `spaBase()` defensive normalizer.** Strips
   trailing slashes; appends `/b3` only when the existing value doesn't
   already end with it. `apps/api/src/lib/email-queue.ts` and the other
   link builders now all go through `spaBase()` — there is no longer
   any code path in the api that emits a public link without the SPA
   mount point.

2. **nginx root-level rewrites for the Bam auth paths**
   (`infra/nginx/nginx.conf`, `nginx-with-site.conf`, `nginx.railway.conf`):

   ```
   rewrite ^/password-reset(/?)$         /b3/password-reset$is_args$args   last;
   rewrite ^/password-change(/?)$        /b3/password-change$is_args$args  last;
   rewrite ^/login(/?)$                  /b3/login$is_args$args            last;
   rewrite ^/register(/?)$               /b3/register$is_args$args         last;
   rewrite ^/bootstrap(/?)$              /b3/bootstrap$is_args$args        last;
   rewrite ^/verify-email/(.+)$          /b3/verify-email/$1$is_args$args  last;
   rewrite ^/guests/accept/(.+)$         /b3/guests/accept/$1$is_args$args last;
   ```

   These run before the catch-all marketing-site fallback. They handle
   two cases:
   - Emails already sitting in inboxes that were built before the api
     fix shipped — the rewrite makes those links land on the SPA.
   - Any future install where someone misconfigures `FRONTEND_URL`.

## How this was verified

A Playwright probe drives the entire loop in a real headed Chromium
browser:

1. A SuperUser logs in via the api, posts to `/org/members/invite` with a
   freshly-generated `loop-<timestamp>@example.test` address.
2. The probe pulls the matching message out of MailHog (added as a
   `--profile mailhog` compose service) and extracts the URL from the
   quoted-printable HTML body.
3. A new incognito browser context (no auth cookies) navigates to that
   URL exactly as a real email client would.
4. The probe asserts the rendered `<h1>` is "Set a new password" (and
   NOT the login form's heading).
5. The probe fills the new-password fields, submits, waits for the
   "Welcome to BigBlueBam" success screen, then clicks "Go to login"
   and signs in with the freshly-set credentials.
6. All three screenshots are captured and the probe asserts the final
   URL is past `/login`.

The probe was checked in (temporarily) at the repo root as
`tmp-invite-loop.spec.ts` while diagnosing; it ran green against both
the WITH-`/b3` and WITHOUT-`/b3` `FRONTEND_URL` scenarios after the
fix landed.

## Deferred / sharp edges

- The `system_settings` PUT route (the one that stores SMTP host as
  JSON-stringified text) is the underlying cause of the earlier
  hostname-with-quotes incident (2026-06-11 morning). The fix landed at
  the read side; the write side still over-stringifies. A
  separately-tracked clean-up will fix the write side so future rows
  store the actual primitive, and add a one-off migration to peel any
  existing rows that were stored doubly. Until then, the read-side
  unwrap handles both shapes correctly.
