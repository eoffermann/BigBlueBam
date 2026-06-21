# Local SSL — design notes, sharp edges, and future work

This document captures the design decisions, gotchas, and deferred work for the local-SSL feature
so future agents and human collaborators don't have to re-derive them. The feature lives in:

- `scripts/deploy/shared/tls.mjs` — prompts and provisioning for self-signed, mkcert, BYO.
- `scripts/deploy/shared/letsencrypt.mjs` — Let's Encrypt issuance + renewal-task wiring.
- `infra/nginx/entrypoint.sh` — boot-time TLS placeholder substitution.
- `infra/nginx/nginx-with-site.conf` — `__HTTP_LISTEN__` / `__TLS_LISTEN_BLOCK__` placeholders.
- `infra/nginx/tls-redirect.conf.template` — auxiliary block for redirect/https-only modes.
- `docker-compose.yml` — `frontend` service mounts `./certs:/etc/nginx/certs:ro`; `certbot`
  service is gated behind compose profile `letsencrypt`.

## Why this exists

Before this work, BigBlueBam's docker-compose deploy flow was HTTP-only. The
`advanced-port-mapping` branch added a `useTls` boolean that influenced URL string formation
(`CORS_ORIGIN`, `FRONTEND_URL`, etc.) but didn't actually serve TLS — nginx kept listening on
port 80 and any operator who picked `useTls=true` was given URLs their browser would reject.
Local SSL closes that gap.

Railway terminates TLS at its edge, so the entire feature is docker-compose-only. The Railway
adapter is intentionally untouched.

## Architecture

**Cert sources (1-of-5 menu, default self-signed):**

1. **Self-signed** — `openssl req -x509` at deploy time. Browser warns once per device but TLS
   itself works correctly (cookies get the `Secure` flag, HSTS is honored, etc.). Right baseline
   for "I just want TLS to function locally."
2. **Bring-your-own** — operator types absolute paths to a cert + key they already have. We
   validate them via `openssl ... modulus` pairing comparison before copying into `./certs/`.
3. **mkcert** — detect via `which mkcert` / `where mkcert`. Run `mkcert -install` (idempotent;
   first-time UAC prompt on Windows) to seed the local CA into the trust store, then issue.
   Deploy machine's browsers trust automatically. Other client devices need the CA installed
   manually.
4. **Let's Encrypt** — certbot sidecar with HTTP-01 / webroot challenge. Initial issuance runs
   AFTER `docker compose up` because certbot needs nginx serving `/.well-known/acme-challenge/`.
   Renewal is a host-side cron entry, NOT an in-container loop (see "Sharp edges" below).
5. **External (reverse proxy / CDN handles TLS)** — BBB itself stays plain HTTP; an upstream
   layer (Cloudflare, Caddy, host nginx, NAS reverse proxy, k8s ingress, etc.) terminates TLS
   on the public side. No certs are provisioned, no certs mounted, no `listen 443 ssl;` block
   rendered — the entrypoint runs `TLS_HTTP_MODE=none` and serves only port 80 internally.
   `formatPublicUrl` still produces `https://domain` (port 443 elided), so `CORS_ORIGIN`,
   `FRONTEND_URL`, and friends match the browser's `Origin` and `COOKIE_SECURE=true` is still
   written into `.env`. HSTS is left to the upstream layer (see "Sharp edges" below).

**HTTP-vs-HTTPS coexistence (operator chooses, default redirect):**

- `redirect` — port 80 issues `301` to `https://$host_no_port:${EXT_HTTPS_PORT}$request_uri`.
- `both` — port 80 keeps serving content alongside port 443.
- `https-only` — port 80 returns `444` (drop without response).

The choice writes `TLS_HTTP_MODE` into `.env`; `entrypoint.sh` reads it on every container
start and renders `nginx-with-site.conf` accordingly.

**Cookie-secure plumbing:**

Picking any TLS source writes `COOKIE_SECURE=true` into `.env`. This is read by every
satellite API's `env.ts` (`apps/{api,helpdesk-api,banter-api,beacon-api,bearing-api,blank-api,
blast-api,board-api,bolt-api,bond-api,book-api,bench-api,brief-api,bill-api}/src/env.ts`) and
flips Fastify's session-cookie `Secure` flag. This single line closes 14 audit findings
(BAM-045, BOLT-011, BRF-020, etc.) — most satellite APIs default `COOKIE_SECURE=false`.

## Sharp edges to avoid (READ BEFORE EXTENDING)

1. **HSTS aggressiveness scales with cert provenance.** Self-signed / mkcert / BYO get
   `max-age=300`. Only Let's Encrypt gets `max-age=31536000; includeSubDomains`. The
   reverse-proxy source returns `null` so the upstream layer owns the header (it's the layer
   that actually terminates TLS, so it's the right place to set policy). Reason for the
   conservative defaults: permanently poisoning a NAS operator's Chrome HSTS cache for
   `nas.local` (a hostname they may later move or repurpose) is a footgun with no clean
   revocation path. Do not "improve" the existing values.

2. **`add_header` directives do not inherit across nginx server blocks.** The existing
   `nginx-with-site.conf` already comments this at the `location /` block. The TLS placeholder
   approach (single server block listening on both ports) avoids the issue entirely; if anyone
   ever splits the config into separate http/https server blocks they MUST repeat every
   security header in both.

3. **Don't mount the docker socket into the certbot sidecar.** The renewal `--deploy-hook`
   needs to reload nginx after a cert refresh, but giving the certbot sidecar docker socket
   access creates a lateral-movement vector if certbot is ever compromised. The renewal model
   intentionally lives on the host: a cron entry runs `docker compose run --rm certbot ...`
   and the deploy-hook fires `docker compose exec frontend nginx -s reload` from the host.

4. **HTTP-01 challenges always hit public port 80.** `letsencrypt.mjs::checkLeCompatibility`
   refuses LE when `HTTP_PORT !== 80`. Don't try to be clever and silently rewrite — LE's
   rate limit is 5 failed validations per hour per account+host, and a half-working flow eats
   that budget fast. Refuse cleanly with router-port-forwarding instructions.

5. **`both` mode + `COOKIE_SECURE=true` has a known footgun.** If the user lands on `http://`
   first (e.g. typed `nas.local` without scheme), the browser silently drops the `Secure`
   session cookie and login appears broken. The deploy script's prompt warns about this in
   ELI5 text and steers operators toward `redirect`. Don't remove the warning.

6. **OAuth callback URLs are NOT baked from `BASE_URL`.** They flow per-request from the
   frontend, so scheme switches at runtime are safe — BUT the OAuth provider console
   (GitHub, Google) has the callback URL allowlisted there and must match. Switching from
   http → https mid-deployment breaks the callback until the operator updates the console.
   The TLS prompt warns when OAuth is configured.

7. **`./certs/` permissions matter.** Mode `0700` on the directory, `0600` on private keys,
   `0644` on certs. `tls.mjs::generateSelfSigned` and friends set these explicitly because
   git doesn't preserve them. Don't lose the chmod calls.

8. **Don't auto-install the renewal cron entry.** NAS hosts often ship without a running
   cron daemon (Synology uses `synosched`, Unraid uses User Scripts, etc.). Silently installing
   into a non-running cron daemon creates a false sense of "renewal handled" that breaks at
   month 3 when the cert expires. Print the cron line for the operator to install themselves.

## Deferred work / "if we ever extend this direction"

These items were explicitly considered and deferred. Don't re-relitigate without reading this:

- **DNS-01 ACME challenge.** Would let LE work behind remapped HTTP_PORT (and behind firewalls
  that don't forward 80), but each DNS provider has its own API and credential model. Picking
  one provider locks operators in; supporting all of them is a big surface. v1 ships HTTP-01
  only with a clear refusal path. If demand comes from a specific provider (Cloudflare, Route
  53, etc.) tackle that one as a follow-up — don't try to abstract.

- **Wildcard certs.** Useful when multiple subdomains under the same apex point at this BBB
  install. v1 issues single-name certs only. mkcert and BYO already support wildcards if the
  operator provides them; LE doesn't (it requires DNS-01 for wildcards, which see above).

- **Cert rotation without redeploy.** Today changing TLS sources requires `--reconfigure`.
  An "in-place rotate" command (e.g. `node scripts/deploy/main.mjs --rotate-certs`) would be
  a small addition but isn't load-bearing for v1.

- **Auto-detect when self-signed certs are about to expire.** Self-signed certs are issued
  for 825 days; at year ~2 the operator has to know to re-run the deploy. Could add a
  health-check that warns when `local.crt` is within 30 days of expiry. v1 doesn't.

- **`mkcert -CAROOT` validation.** `mkcert -install` is idempotent and we run it always, but
  we don't currently verify the rootCA actually landed in the OS trust store afterwards
  (Windows occasionally fails the cert-store write silently when the user dismisses UAC).
  A post-install verification step (`mkcert -verify-install`?) could surface this earlier.

- **Browser-trust verification feedback.** When the operator picks self-signed, we don't
  currently tell them how to install the cert into their browser if they want to skip the
  warning. A short instruction page (`docs/local-ssl-trust.md`) walking through the
  per-browser flow would be operator-friendly.

- **HTTP/2 and HTTP/3.** The TLS server block uses TLS 1.2+1.3 but plain HTTP/1.1. nginx
  supports `http2` on the listen directive trivially; HTTP/3 needs nginx 1.25+ and quiche.
  v1 doesn't enable either. Adding `http2` is one line (`listen 443 ssl http2;`) and probably
  the easiest win to revisit.

- **Per-app cert routing.** All BBB apps share one cert (the wildcard nginx serves on 443).
  An operator hosting Helpdesk on a different cert from Bam isn't supported. Realistic only
  if the operator has separate hostnames per app, which is rare for self-hosted installs.

## Verification recipes

**Self-signed default path:**
```sh
rm -rf ./certs/
node scripts/deploy/main.mjs                                 # accept defaults, pick TLS=self-signed, mode=redirect
curl -kI https://localhost/                                  # 200, Strict-Transport-Security: max-age=300
curl -I http://localhost/                                    # 301 to https://localhost/
```

**Port-remap interaction:**
```sh
node scripts/deploy/main.mjs                                 # pick advanced ports HTTP_PORT=8080 HTTPS_PORT=8443
                                                             # then TLS=self-signed, mode=redirect
curl -kI https://nas.local:8443/                             # 200
curl -I http://nas.local:8080/                               # 301 to https://nas.local:8443/
```

**LE refusal at non-80 HTTP_PORT:** picking LE after remapping HTTP_PORT must refuse and
suggest router port-forwarding.

**`both` mode warning:** picking `both` must surface the secure-cookie warning text in the
prompt before the operator commits.

**Reconfigure preserves certs:**
```sh
node scripts/deploy/main.mjs --reconfigure                   # keep saved TLS choice
ls -la ./certs/local.crt                                     # unchanged mtime
```

## Cross-references

- The advanced-port-mapping branch (where `useTls` originated):
  `scripts/deploy/shared/port-mapping.mjs`, `scripts/deploy/shared/public-url.mjs`.
- Audit findings closed by `COOKIE_SECURE=true`:
  `docs/security-audits/2026-04-09/*.md` — search for "COOKIE_SECURE" or "Secure flag".
- The plan that drove this work: `~/.claude/plans/so-we-re-talking-about-ethereal-walrus.md`
  (per-machine; not in repo).
