#!/usr/bin/env node
// Read audit-output.json and emit docs/wave-d-audit/apps-api.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const IN = path.join(REPO, 'audit-output.json');
const OUT = path.join(REPO, 'docs/wave-d-audit/apps-api.md');

const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
const { counts, perFile, results, outOfScope } = data;

function md(s) { return s.replace(/\|/g, '\\|'); }

// Top-10 highest-value gaps from NO_GATE
// Priority weight: requires_superuser=4, is_destructive=3, !is_read=2, base=1
function priority(r) {
  let w = 1;
  if (r.requires_superuser) w += 4;
  if (r.is_destructive) w += 3;
  if (!r.is_read) w += 2;
  return w;
}

const noGate = results.filter(r => r.classification === 'NO_GATE');
const mismatch = results.filter(r => r.classification === 'MISMATCH');
const missing = results.filter(r => r.classification === 'MISSING_ROUTE');
const inline = results.filter(r => r.classification === 'INLINE_CHECK');
const ok = results.filter(r => r.classification === 'OK');

const topGaps = [...noGate].sort((a,b) => priority(b) - priority(a)).slice(0, 10);

function row(r) {
  const flags = [];
  if (r.requires_superuser) flags.push('SU');
  if (r.is_destructive) flags.push('DESTRUCTIVE');
  if (!r.is_read) flags.push('WRITE');
  return `| \`${md(r.id)}\` | \`${md(r.method + ' ' + r.path)}\` | \`${r.file}:${r.route_line ?? '-'}\` | ${r.gate_pattern ? '`'+md(r.gate_pattern)+'`' : '-'} | ${flags.join(', ') || '-'} | ${md(r.notes || '')} |`;
}

let out = '';
out += '# Wave D audit — apps/api per-action permission coverage\n\n';
out += `_Generated: ${new Date().toISOString()} from \`docs/permissions-action-manifest.json\` and \`apps/api/src/routes/\`_\n\n`;
out += `Audit script: \`scripts/wave-d-audit.mjs\` (read-only).\n\n`;
out += `## 1. Summary counts\n\n`;
out += `| Category | Count |\n|---|---|\n`;
out += `| **Total in-scope permissions** | ${counts.total} |\n`;
out += `| OK (resolver gate present with matching permission_id) | ${counts.OK} |\n`;
out += `| MISMATCH (gate present but with different permission_id) | ${counts.MISMATCH} |\n`;
out += `| NO_GATE (route exists, no dualReadGate / requireCan / shadowOnly) | ${counts.NO_GATE} |\n`;
out += `| MISSING_ROUTE (manifest entry has no matching route handler) | ${counts.MISSING_ROUTE} |\n`;
out += `| INLINE_CHECK (preHandler missing but handler body has \`is_superuser\` gating) | ${counts.INLINE_CHECK} |\n`;
out += `\n`;
out += `OK ratio: **${(counts.OK / counts.total * 100).toFixed(1)}%** (${counts.OK} / ${counts.total}).\n\n`;
out += `Out-of-scope entries skipped (basename collision with sub-app route files, e.g. \`comment.routes.ts\` in apps/brief-api): **${outOfScope.length}**.\n\n`;

out += `### Scope definition\n\n`;
out += `In-scope means: \`source.source === 'rest'\` AND \`path.basename(source.file)\` is present in \`apps/api/src/routes/\` AND (the permission \`app\` is one of \`bam\` / \`platform\` / \`shared\`, OR a matching route handler is actually found in apps/api). The "OR" clause covers a handful of cross-app permissions whose REST surface really does live in the Bam main API (none observed after the collision filter ran — all 52 dropped entries belonged to banter/beacon/board/bolt/book/brief route files of the same basename).\n\n`;

out += `### Gate vocabulary\n\n`;
out += `Counted as a permission gate (the script looks for these in the route's \`preHandler\` text):\n`;
out += `- \`dualReadGate({ ..., permission: '<id>' })\` (Wave B canonical shape)\n`;
out += `- \`requireCan('<id>')\` / \`fastify.requireCan('<id>')\` (Wave C target shape)\n`;
out += `- \`shadowOnly('<id>')\` (for routes that had no legacy gate)\n\n`;
out += `Explicitly NOT counted (per audit brief):\n`;
out += `- \`requireAuth\` (authentication only)\n`;
out += `- \`requireScope(...)\` (API-key scope ceiling)\n`;
out += `- \`requireProjectAccess\` / \`requireProjectAccessForEntity\` (entity visibility)\n`;
out += `- Legacy role gates (\`requireMinRole\`, \`requireOrgRole\`, \`requireRole\`, \`requireProjectRole\`, \`requireSuperuser\`) — when present *without* a dualReadGate wrapper, the row is classified NO_GATE even though authz still happens via the legacy path.\n\n`;

out += `## 2. Per-file coverage\n\n`;
out += `| File | Expected | OK | MISMATCH | NO_GATE | INLINE_CHECK | MISSING_ROUTE | OK % |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`;
const fileRows = Object.entries(perFile)
  .map(([f, v]) => ({ f, ...v, pct: v.expected ? (v.OK / v.expected) * 100 : 0 }))
  .sort((a, b) => b.expected - a.expected);
for (const r of fileRows) {
  out += `| \`${r.f}\` | ${r.expected} | ${r.OK} | ${r.MISMATCH} | ${r.NO_GATE} | ${r.INLINE_CHECK} | ${r.MISSING_ROUTE} | ${r.pct.toFixed(0)}% |\n`;
}
out += `\n`;

out += `## 3. Detail tables\n\n`;
out += `### 3.1 OK (${ok.length}) — gates present with matching permission_id\n\n`;
out += `Compact listing (full data is in \`audit-output.json\`):\n\n`;
out += `| permission_id | method+path | file:line | gate_pattern_found | flags |\n|---|---|---|---|---|\n`;
for (const r of ok) {
  const flags = [];
  if (r.requires_superuser) flags.push('SU');
  if (r.is_destructive) flags.push('DESTRUCTIVE');
  if (!r.is_read) flags.push('WRITE');
  out += `| \`${md(r.id)}\` | \`${md(r.method + ' ' + r.path)}\` | \`${r.file}:${r.route_line}\` | \`${md(r.gate_pattern)}\` | ${flags.join(', ') || '-'} |\n`;
}
out += `\n`;

out += `### 3.2 MISMATCH (${mismatch.length}) — wrong permission_id\n\n`;
if (mismatch.length === 0) {
  out += `_None._\n\n`;
} else {
  out += `| permission_id (expected) | method+path | file:line | gate_pattern_found | notes |\n|---|---|---|---|---|\n`;
  for (const r of mismatch) out += row(r) + '\n';
  out += '\n';
}

out += `### 3.3 NO_GATE (${noGate.length}) — route exists, no permission check in preHandler\n\n`;
out += `Grouped by file. \`legacy_gates\` column reports any \`requireMinRole\` / \`requireOrgRole\` / \`requireRole\` / \`requireProjectRole\` / \`requireSuperuser\` calls found in the same preHandler (these are the legacy role gates the codemod was supposed to wrap with \`dualReadGate\`).\n\n`;
out += `| permission_id | method+path | file:line | legacy_gates_in_preHandler | flags |\n|---|---|---|---|---|\n`;
const noGateSorted = [...noGate].sort((a,b) => {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return (a.route_line ?? 0) - (b.route_line ?? 0);
});
for (const r of noGateSorted) {
  const flags = [];
  if (r.requires_superuser) flags.push('SU');
  if (r.is_destructive) flags.push('DESTRUCTIVE');
  if (!r.is_read) flags.push('WRITE');
  out += `| \`${md(r.id)}\` | \`${md(r.method + ' ' + r.path)}\` | \`${r.file}:${r.route_line}\` | ${r.legacy_gates || '_(none — pure requireAuth/scope/project)_'} | ${flags.join(', ') || '-'} |\n`;
}
out += `\n`;

out += `### 3.4 MISSING_ROUTE (${missing.length}) — manifest entry has no matching handler\n\n`;
if (missing.length === 0) {
  out += `_None._ (52 manifest rows whose \`file\` basename also exists in apps/api but whose paths only match handlers in other apps' route files have been filtered out as out-of-scope. See \`outOfScope\` in \`audit-output.json\`.)\n\n`;
} else {
  out += `| permission_id | method+path | file (manifest) | notes |\n|---|---|---|---|\n`;
  for (const r of missing) out += `| \`${md(r.id)}\` | \`${md(r.method + ' ' + r.path)}\` | \`${r.file}\` | ${md(r.notes || '')} |\n`;
  out += `\n`;
}

out += `### 3.5 INLINE_CHECK (${inline.length}) — preHandler lacks gate, handler body has \`is_superuser\` gating\n\n`;
if (inline.length === 0) {
  out += `_None._\n\n`;
} else {
  out += `| permission_id | method+path | file:line | notes |\n|---|---|---|---|\n`;
  for (const r of inline) out += `| \`${md(r.id)}\` | \`${md(r.method + ' ' + r.path)}\` | \`${r.file}:${r.route_line}\` | ${md(r.notes || '')} |\n`;
  out += `\n`;
  out += `Note: the heuristic matches \`if (... is_superuser ...) ... reply.(status|code)(403|401) | FORBIDDEN | UNAUTHORIZED\` within the first 80 lines of the handler body. False negatives are possible for inline checks that throw via a helper or set \`reply.send\` without a status code. False positives are possible if a route emits a 403 inside a deeply nested branch whose superuser check is unrelated to authorization — re-confirm by reading the file.\n\n`;
}

out += `## 4. Top 10 highest-value gaps to fix first\n\n`;
out += `Ranked by priority weight (requires_superuser × 4 + is_destructive × 3 + non-read × 2 + 1).\n\n`;
out += `| # | permission_id | method+path | file:line | flags | priority |\n|---|---|---|---|---|---|\n`;
let i = 1;
for (const r of topGaps) {
  const flags = [];
  if (r.requires_superuser) flags.push('SU');
  if (r.is_destructive) flags.push('DESTRUCTIVE');
  if (!r.is_read) flags.push('WRITE');
  out += `| ${i++} | \`${md(r.id)}\` | \`${md(r.method + ' ' + r.path)}\` | \`${r.file}:${r.route_line}\` | ${flags.join(', ') || '-'} | ${priority(r)} |\n`;
}
out += `\n`;
out += `_Recommendation_: wrap each of the above with \`shadowOnly('<id>')\` first (since most have no legacy role gate to dual-read against), confirm divergence telemetry stays quiet for one full enforcement window, then promote to \`requireCan('<id>')\` before flipping \`BBB_PERMISSIONS_ENFORCE=on\`.\n\n`;

out += `## 5. Anomalies & open questions\n\n`;

// Anomaly: routes with multiple distinct permission claims in same preHandler
const multiPerm = [];
// Walk route preHandlers across all in-scope routes to find ones with >1 distinct permission gate.
// We have to re-derive from parsed gate text — easiest: count NO_GATE/OK rows that share file+line and have different gate ids? We don't have that in this dataset, but we can scan the audit file for stacked gates by walking routes.
// Use the OK rows: same (file, route_line) appearing multiple times with different permission ids implies a route is claimed by multiple manifest entries.
const lineMap = {};
for (const r of results) {
  if (!r.route_line) continue;
  const key = `${r.file}:${r.route_line}`;
  (lineMap[key] = lineMap[key] || []).push(r);
}
const multiClaim = Object.entries(lineMap).filter(([_, rs]) => rs.length > 1);

out += `### 5.1 Routes claimed by more than one manifest entry\n\n`;
if (multiClaim.length === 0) {
  out += `_None._\n\n`;
} else {
  out += `${multiClaim.length} routes are referenced by more than one manifest permission. This is usually fine (one handler implements multiple verbs by query/body), but it does mean a single \`dualReadGate\` cannot satisfy both; the resolver only checks one \`permission_id\` per request. Investigate whether one of the manifest entries is stale.\n\n`;
  out += `| file:line | permissions claiming it |\n|---|---|\n`;
  for (const [k, rs] of multiClaim) {
    out += `| \`${k}\` | ${rs.map(r => '`'+r.id+'` ('+r.classification+')').join(', ')} |\n`;
  }
  out += `\n`;
}

// Anomaly: NO_GATE rows where no other gate at all (pure requireAuth+scope)
out += `### 5.2 NO_GATE rows with no legacy gate either (pure \`requireAuth\` / \`requireScope\` / \`requireProjectAccess\`)\n\n`;
const pureNoGate = noGate.filter(r => !r.legacy_gates);
out += `**${pureNoGate.length} of ${noGate.length} NO_GATE rows have no legacy authorization gate at all.** These are the riskiest gaps before flipping \`=on\`: today they 200 for any authenticated user (subject to scope and project visibility); after \`=on\` they will still 200, but the resolver will record \`null\` decisions because \`requireCan\` was never called. Either:\n\n`;
out += `1. They are intentionally public-ish endpoints (\`/auth/me\`, \`/auth/login\`, \`/launchpad\`, \`/agents/heartbeat\`) — in which case the manifest entry exists but no permission gate is needed; consider marking these \`is_core: true\` in the manifest so the audit can ignore them, or add \`shadowOnly('<id>')\` to capture telemetry.\n`;
out += `2. They are oversights from Wave A/B/C where the codemod could not match the route — these need explicit \`shadowOnly\` or \`requireCan\` wraps before \`=on\`.\n\n`;
out += `Quick triage: of the ${pureNoGate.length} no-legacy-gate rows, ${pureNoGate.filter(r => r.requires_superuser || r.is_destructive).length} are flagged \`requires_superuser\` or \`is_destructive\` and must NOT remain ungated under \`=on\`.\n\n`;

// Anomaly: routes with legacy gates but no dualRead wrapper
out += `### 5.3 NO_GATE rows that still have legacy role gates\n\n`;
const legacyButNoDualRead = noGate.filter(r => r.legacy_gates);
if (legacyButNoDualRead.length === 0) {
  out += `_None observed._ Every legacy role gate in apps/api routes appears to be wrapped by \`dualReadGate\` (this confirms Wave C's codemod ran successfully against the legacy-gated subset).\n\n`;
} else {
  out += `${legacyButNoDualRead.length} routes still call a legacy role gate (e.g. \`requireMinRole('admin')\`) directly without \`dualReadGate\`. The codemod missed them. Listing:\n\n`;
  out += `| permission_id | method+path | file:line | legacy_gates |\n|---|---|---|---|\n`;
  for (const r of legacyButNoDualRead) out += `| \`${md(r.id)}\` | \`${md(r.method+' '+r.path)}\` | \`${r.file}:${r.route_line}\` | ${r.legacy_gates} |\n`;
  out += `\n`;
}

// Anomaly: outOfScope summary
out += `### 5.4 Manifest entries silently routed to other apps (basename collision)\n\n`;
out += `${outOfScope.length} manifest entries have a \`file\` whose basename exists in \`apps/api/src/routes/\` AND in some sub-app's \`apps/<app>-api/src/routes/\`. The script dropped them as out-of-scope because the path/method does not match any handler in apps/api. The manifest-builder probably stamped the basename ambiguously — consider including the full repo-relative file path in \`source.file\` going forward so future audits don't have to disambiguate by route-match. Breakdown:\n\n`;
const byApp = {};
for (const r of outOfScope) byApp[r.app] = (byApp[r.app] || 0) + 1;
for (const [app, count] of Object.entries(byApp).sort((a,b) => b[1]-a[1])) {
  out += `- \`${app}\`: ${count} entries\n`;
}
out += `\n`;

// Anomaly: shadowOnly usage
const shadowSites = results.filter(r => r.gate_pattern && r.gate_pattern.includes('shadowOnly'));
out += `### 5.5 \`shadowOnly\` adoption\n\n`;
out += `\`shadowOnly\` (the convenience for routes that have no legacy gate, just to record resolver telemetry) currently covers **${shadowSites.length}** of the in-scope routes. With ${pureNoGate.length} legacy-less NO_GATE rows still present, there is significant headroom to expand \`shadowOnly\` adoption before \`=on\`.\n\n`;

out += `### 5.6 \`requires_superuser\` permissions still ungated\n\n`;
const ungatedSU = noGate.filter(r => r.requires_superuser);
if (ungatedSU.length === 0) {
  out += `_None._\n\n`;
} else {
  out += `${ungatedSU.length} permissions flagged \`requires_superuser: true\` in the manifest currently have no permission gate in their route preHandler:\n\n`;
  out += `| permission_id | method+path | file:line | legacy_gates |\n|---|---|---|---|\n`;
  for (const r of ungatedSU) out += `| \`${md(r.id)}\` | \`${md(r.method+' '+r.path)}\` | \`${r.file}:${r.route_line}\` | ${r.legacy_gates || '_(none)_'} |\n`;
  out += `\n`;
}

out += `### 5.7 Open questions for the wave lead\n\n`;
out += `1. **Are public auth endpoints in-scope?** \`bam.auth_login.create\`, \`bam.auth_register.create\`, \`bam.auth_bootstrap.create\`, \`bam.auth_logout.create\`, \`bam.auth_me.list\`, and \`/public/config\` legitimately have no permission gate because they predate authentication or are the authentication flow themselves. They should likely be marked \`is_core\` (analogous to MCP's "always permitted" set: \`get_server_info\`, \`get_me\`, \`agent_heartbeat\`) or otherwise excluded from coverage targets.\n`;
out += `2. **Internal/service routes** under \`/internal/helpdesk\` and \`/internal/llm\` are gated by \`INTERNAL_SERVICE_SECRET\` at the network layer and don't fit the human-permission model. Should they be removed from the manifest, or kept with a sentinel permission like \`platform.internal.invoke\` and the gate enforced via a different middleware?\n`;
out += `3. **Webhook receivers** (\`POST /webhooks/slack\`, \`POST /webhooks/github\`, \`POST /webhooks/livekit\`) authenticate via HMAC signature, not session. Same question as (2): these should probably be marked \`is_core\` or excluded.\n`;
out += `4. **Routes with multiple manifest claims** (section 5.1) need a single canonical \`permission_id\` chosen before \`=on\` — the resolver only fires one check per request.\n\n`;

out += `## 6. Verdict on flipping \`BBB_PERMISSIONS_ENFORCE=on\`\n\n`;
out += `**Not safe today.** With ${counts.NO_GATE} ungated routes (${pureNoGate.length} of which have no legacy authorization gate of any kind, including ${ungatedSU.length} flagged \`requires_superuser\` and ${pureNoGate.filter(r => r.is_destructive).length} flagged \`is_destructive\`), turning \`=on\` would either:\n\n`;
out += `- if the resolver's default-deny posture is per-action: cause every ungated route to 403 for every caller including SuperUsers (a large operational regression);\n`;
out += `- if the resolver's default-deny is bypassed when no \`requireCan\` is on the route: silently allow them, which defeats the purpose of \`=on\` and leaves ${ungatedSU.length} SuperUser-only actions accessible to any authenticated user under the new model.\n\n`;
out += `**Suggested pre-flip checklist:**\n\n`;
out += `1. Resolve every row in section 3.3 (NO_GATE) by either (a) adding \`requireCan('<id>')\` to the preHandler, (b) adding \`shadowOnly('<id>')\` if the route is genuinely public, or (c) marking the manifest entry \`is_core\`/\`public\` and excluding it from coverage requirements.\n`;
out += `2. Resolve the routes-with-multiple-claims (section 5.1) so each handler has exactly one canonical \`permission_id\`.\n`;
out += `3. Re-run \`scripts/wave-d-audit.mjs\` and verify \`OK + INLINE_CHECK + (core/public-excluded)\` covers 100% of in-scope rows.\n`;
out += `4. Run divergence telemetry under \`=warn\` for at least one full enforcement window after the gate-additions land; spot-check that the divergence dashboard is quiet (no resolver-denies-but-legacy-allows on Bam routes).\n`;
out += `5. Then flip \`BBB_PERMISSIONS_ENFORCE=on\` and watch \`permissions_divergence_log\` for the first 24 hours.\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log('Wrote', OUT, '—', out.length, 'bytes');
