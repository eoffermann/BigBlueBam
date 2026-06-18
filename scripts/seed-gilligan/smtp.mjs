/**
 * Gilligan's Island themed SMTP seed — BOTH levels.
 *
 * Populates demo (NON-DELIVERABLE, dummy) SMTP configuration so the two new
 * SMTP cards render populated in screenshots and demos:
 *
 *   1. PLATFORM SMTP — system_settings smtp_* rows, the platform-wide fallback
 *      relay shown in the SuperUser Console -> Platform tab
 *      (apps/frontend/src/components/superuser/smtp-settings-card.tsx).
 *      Written via PUT /system-settings/:key for each smtp_* key. Requires a
 *      SuperUser session, so the caller passes a short-lived SuperUser API key
 *      in SU_KEY (minted + revoked by the host wrapper around this script).
 *
 *   2. ORG SMTP — organizations.settings.smtp for the Gilligan org, the
 *      per-org override shown in Bam Settings -> Integrations
 *      (apps/frontend/src/components/settings/org-smtp-settings-form.tsx).
 *      Written via PUT /org/smtp-settings. That route is gated on
 *      requireScope('admin'), so the caller passes a short-lived admin-scope
 *      key for the Gilligan org owner (the Skipper) in ORG_ADMIN_KEY.
 *
 * IMPORTANT: every value here is a deliberately NON-DELIVERABLE placeholder.
 *   - host:  smtp.gilligan-travel.example  (reserved .example TLD — never resolves)
 *   - port:  587
 *   - from:  Gilligan Travel <noreply@gilligan-travel.example>
 *   - user:  a placeholder login, NOT a real mailbox
 *   - pass:  a dummy non-secret string (the relay never authenticates anywhere)
 * Nothing here can or will send real outbound mail. Do NOT replace with real
 * credentials.
 *
 * Idempotent: reads the current config first and only writes the keys that are
 * missing or different, so re-running is a no-op once seeded.
 *
 * Why this seeder mints its own keys instead of reusing scripts/.gilligan-keys.env:
 *   - The cast keys in that file are all `read_write` scope, but PUT
 *     /org/smtp-settings is gated on requireScope('admin'), and the platform
 *     keys live under system_settings (SuperUser-gated). Neither is reachable
 *     with a read_write cast key, and there is no SuperUser key in that file.
 *   - So the host wrapper below mints two short-lived (1-day) keys, runs the
 *     seed, and immediately revokes them — nothing long-lived is left behind.
 *
 * Run from the repo host:
 *   # 1. Mint a temporary SuperUser admin key (any SuperUser + their home org)
 *   #    and a temporary admin key for the Gilligan org owner (the Skipper).
 *   SU_OUT=$(docker compose exec -T api node dist/cli.js create-api-key \
 *     --email eddie@bigblueceiling.com --name smtp-seed-temp-su \
 *     --scope admin --org-slug big-blue-ceiling --expires-days 1)
 *   ORG_OUT=$(docker compose exec -T api node dist/cli.js create-api-key \
 *     --email skipper@gilligantravel.example --name smtp-seed-temp-org \
 *     --scope admin --org-slug gilligan-travel-ltd --expires-days 1)
 *   SU_KEY=$(echo "$SU_OUT" | sed -nE 's/.*Token:[[:space:]]+//p')
 *   ORG_ADMIN_KEY=$(echo "$ORG_OUT" | sed -nE 's/.*Token:[[:space:]]+//p')
 *   SU_ID=$(echo "$SU_OUT"  | sed -nE 's/.*Key ID:[[:space:]]+//p')
 *   ORG_ID=$(echo "$ORG_OUT" | sed -nE 's/.*Key ID:[[:space:]]+//p')
 *
 *   # 2. Seed both levels.
 *   docker compose exec -T -e SU_KEY="$SU_KEY" -e ORG_ADMIN_KEY="$ORG_ADMIN_KEY" \
 *     api node - < scripts/seed-gilligan/smtp.mjs
 *
 *   # 3. Revoke the temporary keys (hard delete).
 *   docker compose exec -T api node dist/cli.js revoke-api-key --id "$SU_ID"  --prefix "${SU_KEY:0:8}"
 *   docker compose exec -T api node dist/cli.js revoke-api-key --id "$ORG_ID" --prefix "${ORG_ADMIN_KEY:0:8}"
 *
 * Each level is independent: omit SU_KEY to seed only the org level, or omit
 * ORG_ADMIN_KEY to seed only the platform level.
 */

const API = 'http://localhost:4000';
const SU_KEY = process.env.SU_KEY || '';
const ORG_ADMIN_KEY = process.env.ORG_ADMIN_KEY || '';

// Dummy, non-deliverable demo values. Reserved .example TLD => never resolves,
// so even an accidental send attempt fails closed at DNS.
const PLATFORM_SMTP = {
  smtp_host: 'smtp.gilligan-travel.example',
  smtp_port: 587,
  smtp_user: 'mailer@gilligan-travel.example',
  smtp_password: 'demo-not-a-real-password',
  smtp_from: 'noreply@gilligan-travel.example',
  smtp_secure: false,
};

const ORG_SMTP = {
  host: 'smtp.gilligan-travel.example',
  port: 587,
  user: 'lagoon-mailer@gilligan-travel.example',
  password: 'demo-not-a-real-password',
  // The org form's "From Address" is a full mailbox/display string.
  from: 'Gilligan Travel <noreply@gilligan-travel.example>',
  secure: false,
};

async function call(key, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data ?? data;
}

// ── Platform SMTP (system_settings, SuperUser-gated) ───────────────────────
async function seedPlatform() {
  if (!SU_KEY) {
    console.log('platform-smtp: SU_KEY unset — skipping (no SuperUser key supplied)');
    return;
  }
  // Read the current system_settings list so we only write missing/different keys.
  const rows = await call(SU_KEY, 'GET', '/system-settings');
  const current = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.key, r.value]));

  let wrote = 0;
  for (const [key, value] of Object.entries(PLATFORM_SMTP)) {
    const existing = current.get(key);
    // smtp_password is masked on read (returns a •••• sentinel). Treat "already
    // has a non-empty value" as satisfied so a re-run never clobbers/re-writes it.
    if (key === 'smtp_password') {
      if (typeof existing === 'string' && existing.length > 0) {
        continue;
      }
    } else if (existing !== undefined && String(existing) === String(value)) {
      continue;
    }
    await call(SU_KEY, 'PUT', `/system-settings/${key}`, { value });
    wrote++;
  }
  console.log(`platform-smtp: ${wrote === 0 ? 'already up to date' : `${wrote} key(s) written`} (host ${PLATFORM_SMTP.smtp_host})`);
}

// ── Org SMTP override (organizations.settings.smtp, admin-scope-gated) ──────
async function seedOrg() {
  if (!ORG_ADMIN_KEY) {
    console.log('org-smtp: ORG_ADMIN_KEY unset — skipping (no admin-scope org key supplied)');
    return;
  }
  const cur = await call(ORG_ADMIN_KEY, 'GET', '/org/smtp-settings');
  // configured + matching host/port/from/user => already seeded; re-run no-op.
  const matches =
    cur &&
    cur.configured === true &&
    cur.host === ORG_SMTP.host &&
    Number(cur.port) === ORG_SMTP.port &&
    cur.from === ORG_SMTP.from &&
    cur.user === ORG_SMTP.user;
  if (matches) {
    console.log(`org-smtp: already up to date (host ${ORG_SMTP.host})`);
    return;
  }
  await call(ORG_ADMIN_KEY, 'PUT', '/org/smtp-settings', ORG_SMTP);
  console.log(`org-smtp: written (host ${ORG_SMTP.host}, from "${ORG_SMTP.from}")`);
}

(async () => {
  await seedPlatform();
  await seedOrg();
  console.log('SMTP seed done.');
})().catch((e) => {
  console.error('smtp seed failed:', e.message);
  process.exit(1);
});
