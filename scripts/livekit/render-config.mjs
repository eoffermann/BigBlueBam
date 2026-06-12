#!/usr/bin/env node
/**
 * LiveKit config renderer + network-topology detector.
 *
 * Renders infra/livekit/livekit.yaml from livekit.yaml.template with an
 * ICE candidate advertisement that works for BOTH LAN and remote (WAN)
 * clients at the same time, with zero hardcoded addresses anywhere in
 * tracked files. WebRTC's ICE does the per-client negotiation: the
 * server advertises a LIST of addresses, every client probes all of
 * them in parallel, and whichever answers wins. This script's job is
 * to make that list complete and fresh.
 *
 * Runs in two modes (--mode=host|container):
 *
 *   host       Run on the docker host (deploy script, or the operator
 *              one-liner below). Detects the host's LAN IP via the
 *              UDP-connect routing trick — only the host can see its
 *              own interfaces — and persists it to <workdir>/.lan-ip
 *              for container-mode renders to reuse. Also renders.
 *
 *   container  Run by the `livekit-config` one-shot compose service on
 *              EVERY `docker compose up`, before the livekit container
 *              starts. Re-detects the WAN IP via STUN (HTTPS fallback)
 *              so a rotated public address never goes stale, reads the
 *              persisted LAN IP, renders, and reports topology changes
 *              and detection problems to the platform system_errors
 *              Log so any deployer can troubleshoot from the SuperUser
 *              Log Analysis tab.
 *
 * Operator one-liner after a network change:
 *   node scripts/livekit/render-config.mjs && docker compose up -d --force-recreate livekit-config livekit
 *
 * Env contract (all optional):
 *   LIVEKIT_NODE_IP        auto (default) | none | <ip>   LAN/host candidate
 *   LIVEKIT_EXTERNAL_IP    auto (default) | none | <ip>   public candidate
 *   LIVEKIT_UDP_PORT_RANGE 51000-51100 (default)          must match compose mapping (it does — same var)
 *   LIVEKIT_TURN_DOMAIN / LIVEKIT_TURN_CERT_FILE / LIVEKIT_TURN_KEY_FILE
 *                          all three set → TURN-TLS block rendered on :5349
 *   LIVEKIT_API_KEY / LIVEKIT_API_SECRET                  devkey/secret fallback
 *   INTERNAL_SERVICE_SECRET + BBB_API_INTERNAL_URL        enables Log reporting (container mode)
 *
 * Zero npm dependencies — node:dgram + node:https + global fetch only —
 * so it runs identically under the repo, the deploy script, and a bare
 * node:22-alpine container.
 */

import dgram from 'node:dgram';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested in render-config.test.mjs)
// ─────────────────────────────────────────────────────────────────────

export function isValidIpv4(s) {
  if (typeof s !== 'string') return false;
  const parts = s.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Parse "51000-51100" → { start, end }. Falls back to the default on
 *  malformed input rather than crashing the render (a broken range
 *  would take down calling entirely; the default is always sane). */
export function parseUdpRange(raw, fallback = '51000-51100') {
  const tryParse = (s) => {
    const m = /^(\d{2,5})-(\d{2,5})$/.exec(String(s ?? '').trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start < 1024 || end > 65535 || end < start) return null;
    return { start, end };
  };
  return tryParse(raw) ?? tryParse(fallback);
}

/**
 * Decide what to advertise. Inputs are the two env intents plus the
 * detection results; output is the deduped candidate list and the
 * topology facts the reporter needs.
 */
export function decideAdvertisement({ nodeIpEnv, externalIpEnv, detectedLan, detectedWan }) {
  const warnings = [];

  const resolveIntent = (intent, detected, label) => {
    const v = String(intent ?? 'auto').trim().toLowerCase();
    if (v === 'none') return null;
    if (v === '' || v === 'auto') {
      if (detected && isValidIpv4(detected)) return detected;
      warnings.push(label === 'lan' ? 'LAN_IP_UNKNOWN' : 'WAN_DETECT_FAILED');
      return null;
    }
    if (isValidIpv4(intent.trim())) return intent.trim();
    warnings.push(label === 'lan' ? 'LAN_IP_INVALID' : 'WAN_IP_INVALID');
    return null;
  };

  const lan = resolveIntent(nodeIpEnv, detectedLan, 'lan');
  const wan = resolveIntent(externalIpEnv, detectedWan, 'wan');

  const ips = [];
  if (lan) ips.push(lan);
  if (wan && wan !== lan) ips.push(wan);

  return {
    lan,
    wan,
    ips,
    // Behind NAT: the host's local address differs from how the
    // internet sees it. Remote media is then deterministic only with
    // router forwards (or TURN); without them it depends on the
    // client's NAT type.
    behindNat: Boolean(lan && wan && lan !== wan),
    fallbackExternal: ips.length === 0,
    // STUN stays on unless the operator declared the deploy air-gapped
    // (LIVEKIT_EXTERNAL_IP=none). It gives the server srflx (public-
    // mapping) candidates per media socket, which is what remote
    // clients connect to when no explicit WAN advertisement applies.
    useStun: String(externalIpEnv ?? 'auto').trim().toLowerCase() !== 'none',
    warnings,
  };
}

/**
 * Connectivity block. This LiveKit build (verified against the binary —
 * `nat_1to1_ips` was rejected at parse time) advertises a SINGLE
 * address via node_ip / use_external_ip, so multi-network reachability
 * comes from running the protocol properly instead of from a candidate
 * list:
 *
 *   - node_ip <LAN>: same-network clients get a direct host candidate.
 *   - use_ice_lite: false — FULL ICE. The server actively sends
 *     connectivity checks toward every candidate each client offers,
 *     instead of passively waiting to be reached (ICE-Lite). This is
 *     the per-connection LAN-vs-WAN negotiation: a client the
 *     advertisement doesn't fit (a remote caller when we advertise
 *     LAN, or a LAN caller when we advertise WAN) still connects,
 *     because the server reaches out to the client's own addresses.
 *   - stun_servers: lets the server learn its public mapping per media
 *     socket (srflx candidates), giving remote clients a public target
 *     even when no explicit WAN address is advertised. Router forwards
 *     (TCP 7881 + the UDP range) make remote media deterministic; the
 *     LIVEKIT_BEHIND_NAT Log row spells that out per deploy.
 */
export function buildRtcAdvertiseBlock(decision) {
  const lines = [
    '  # Connectivity — rendered by scripts/livekit/render-config.mjs; do not',
    '  # hand-edit (re-rendered on every `docker compose up`). Full ICE plus',
    '  # STUN means the server negotiates per-client reachability instead of',
    '  # trusting a single advertised address. See docs/livekit-networking-notes.md.',
  ];
  if (decision.lan) {
    lines.push(`  node_ip: ${decision.lan}`);
    lines.push('  use_external_ip: false');
  } else {
    // No LAN address known (or operator suppressed it): advertise the
    // boot-time STUN-detected public address instead.
    lines.push('  use_external_ip: true');
  }
  lines.push('  use_ice_lite: false');
  if (decision.useStun) {
    lines.push('  stun_servers:');
    lines.push('    - stun.l.google.com:19302');
    lines.push('    - global.stun.twilio.com:3478');
  }
  return lines.join('\n');
}

export function buildTurnBlock({ domain, certFile, keyFile }) {
  const d = String(domain ?? '').trim();
  const c = String(certFile ?? '').trim();
  const k = String(keyFile ?? '').trim();
  if (!d || !c || !k) {
    return [
      '# turn: disabled — set LIVEKIT_TURN_DOMAIN + LIVEKIT_TURN_CERT_FILE +',
      '# LIVEKIT_TURN_KEY_FILE to enable the TURN-TLS relay (last resort for',
      '# clients on networks that block direct UDP/TCP media). See',
      '# docs/livekit-networking-notes.md.',
    ].join('\n');
  }
  return [
    '# TURN over TLS — relay of last resort for clients whose networks block',
    '# direct media. Requires DNS for the domain to point at this host and',
    '# TCP 5349 reachable from those clients.',
    'turn:',
    '  enabled: true',
    `  domain: ${d}`,
    '  tls_port: 5349',
    `  cert_file: ${c}`,
    `  key_file: ${k}`,
  ].join('\n');
}

export function renderTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(key).join(value);
  }
  // A leftover placeholder means the template and renderer have drifted
  // apart — refuse to write a config LiveKit would choke on (or worse,
  // silently misparse).
  const leftover = out.match(/__LIVEKIT_[A-Z_]+__/);
  if (leftover) {
    throw new Error(`renderTemplate: unsubstituted placeholder ${leftover[0]}`);
  }
  return out;
}

/**
 * Parse a STUN binding-success response and extract the mapped IPv4.
 * Prefers XOR-MAPPED-ADDRESS (0x0020); accepts MAPPED-ADDRESS (0x0001)
 * from ancient servers. Returns null when the packet isn't a usable
 * binding success for our transaction.
 */
export function parseStunResponse(msg, txid) {
  if (!Buffer.isBuffer(msg) || msg.length < 20) return null;
  if (msg.readUInt16BE(0) !== 0x0101) return null; // binding success
  if (msg.readUInt32BE(4) !== 0x2112a442) return null; // magic cookie
  if (txid && !msg.subarray(8, 20).equals(txid)) return null;

  const bodyLen = msg.readUInt16BE(2);
  const end = Math.min(20 + bodyLen, msg.length);
  let xorIp = null;
  let plainIp = null;
  let off = 20;
  while (off + 4 <= end) {
    const attrType = msg.readUInt16BE(off);
    const attrLen = msg.readUInt16BE(off + 2);
    const val = msg.subarray(off + 4, Math.min(off + 4 + attrLen, end));
    if (val.length >= 8 && val[1] === 0x01) {
      if (attrType === 0x0020) {
        xorIp = [val[4] ^ 0x21, val[5] ^ 0x12, val[6] ^ 0xa4, val[7] ^ 0x42].join('.');
      } else if (attrType === 0x0001) {
        plainIp = [val[4], val[5], val[6], val[7]].join('.');
      }
    }
    off += 4 + attrLen + ((4 - (attrLen % 4)) % 4); // attrs pad to 4 bytes
  }
  return xorIp ?? plainIp;
}

// ─────────────────────────────────────────────────────────────────────
// Detection (network side effects)
// ─────────────────────────────────────────────────────────────────────

/**
 * LAN IP via the UDP-connect routing trick: connect() on a UDP socket
 * sends NO packets but makes the OS resolve routing, exposing the
 * source address it would use for the default route. Picks the right
 * interface on multi-NIC hosts (Hyper-V vEthernet adapters have no
 * default gateway and are skipped naturally). Host mode only —
 * containers would see their bridge IP, which is useless to advertise.
 */
export function detectLanIp() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => done(null), 1000);
    timer.unref?.();
    sock.on('error', () => done(null));
    try {
      sock.connect(53, '8.8.8.8', () => {
        try {
          const addr = sock.address().address;
          done(addr && addr !== '0.0.0.0' && isValidIpv4(addr) ? addr : null);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

function stunQuery(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0); // binding request
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(0x2112a442, 4);
    const txid = Buffer.alloc(12);
    for (let i = 0; i < 12; i++) txid[i] = Math.floor(Math.random() * 256);
    txid.copy(req, 8);
    sock.on('error', () => done(null));
    sock.on('message', (msg) => {
      const ip = parseStunResponse(msg, txid);
      if (ip && isValidIpv4(ip)) done(ip);
    });
    sock.send(req, port, host, (err) => {
      if (err) done(null);
    });
  });
}

function httpsIpQuery(host, pathName = '/', timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = https.get(
      { host, path: pathName, timeout: timeoutMs, headers: { 'user-agent': 'bigbluebam-livekit-config' } },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > 64) req.destroy();
        });
        res.on('end', () => {
          const ip = body.trim();
          resolve(isValidIpv4(ip) ? ip : null);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** Public IP: STUN first (same mechanism LiveKit itself uses; if STUN
 *  works from here, WebRTC UDP likely works too), HTTPS as a fallback
 *  for networks that filter outbound UDP. */
export async function detectWanIp() {
  const stunServers = [
    ['stun.l.google.com', 19302],
    ['global.stun.twilio.com', 3478],
  ];
  for (const [host, port] of stunServers) {
    const ip = await stunQuery(host, port);
    if (ip) return { ip, via: `stun:${host}` };
  }
  const httpsServices = [
    ['api.ipify.org', '/'],
    ['checkip.amazonaws.com', '/'],
  ];
  for (const [host, p] of httpsServices) {
    const ip = await httpsIpQuery(host, p);
    if (ip) return { ip, via: `https:${host}` };
  }
  return { ip: null, via: null };
}

// ─────────────────────────────────────────────────────────────────────
// Log reporting (system_errors — the SuperUser Log Analysis tab)
// ─────────────────────────────────────────────────────────────────────

const REPORT_MESSAGES = {
  LIVEKIT_BEHIND_NAT: (d, range) =>
    `LiveKit is behind NAT (LAN ${d.lan}, public ${d.wan}). LAN clients connect directly to the advertised LAN address. ` +
    `Remote (internet) clients connect via the server's STUN-discovered public mapping, which works on most home/cone NATs but is NOT guaranteed; ` +
    `to make remote media deterministic, forward TCP 7881 and UDP ${range.start}-${range.end} on the router/firewall to this host, or configure TURN ` +
    `(LIVEKIT_TURN_DOMAIN + cert/key — see docs/livekit-networking-notes.md). Remote callers that cannot connect surface as BUREAU_CONNECT_FAILED rows here. ` +
    `If this deployment is intentionally LAN-only, this row is informational; set LIVEKIT_EXTERNAL_IP=none to silence it.`,
  LIVEKIT_LAN_IP_UNKNOWN: () =>
    `LiveKit could not determine the docker host's LAN IP (containers cannot see host network interfaces), so no LAN candidate is advertised ` +
    `and devices on the local network may fail to connect to calls. Fix: run \`node scripts/livekit/render-config.mjs\` on the docker host ` +
    `(the deploy script does this automatically), or set LIVEKIT_NODE_IP=<host-lan-ip> in .env; then \`docker compose up -d --force-recreate livekit-config livekit\`.`,
  LIVEKIT_WAN_DETECT_FAILED: () =>
    `Public-IP detection failed over both STUN and HTTPS (no internet egress from the docker network?), so no WAN candidate is advertised ` +
    `and remote clients cannot connect to calls. Set LIVEKIT_EXTERNAL_IP=<public-ip> in .env to override, or LIVEKIT_EXTERNAL_IP=none if this deployment is intentionally LAN-only.`,
  LIVEKIT_ADVERTISE_FALLBACK: () =>
    `No usable ICE address was detected or configured; LiveKit fell back to boot-time STUN (use_external_ip). LAN clients will likely fail to connect. ` +
    `Fix LAN: run \`node scripts/livekit/render-config.mjs\` on the docker host or set LIVEKIT_NODE_IP in .env. Fix WAN: set LIVEKIT_EXTERNAL_IP in .env.`,
  LIVEKIT_LAN_IP_INVALID: () =>
    `LIVEKIT_NODE_IP in .env is not a valid IPv4 address and was ignored. Set a valid address, "auto", or "none".`,
  LIVEKIT_WAN_IP_INVALID: () =>
    `LIVEKIT_EXTERNAL_IP in .env is not a valid IPv4 address and was ignored. Set a valid address, "auto", or "none".`,
};

async function reportToLog({ apiBase, secret, code, message, payload, log }) {
  if (!apiBase || !secret) return false;
  const url = `${apiBase.replace(/\/+$/, '')}/internal/system-errors/record`;
  const body = JSON.stringify({
    service: 'livekit-config',
    error_code: code,
    message,
    payload,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
        body,
      });
      if (res.ok || res.status === 204) return true;
    } catch {
      /* api may not be up yet on cold boot — retry below */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`! could not deliver ${code} to the platform Log (api unreachable); the details above are stdout-only this boot`);
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Main render flow
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal .env loader for host-mode CLI runs. Without this, an operator
 * one-liner would render `devkey:secret` keys while the running api
 * signs tokens with the real LIVEKIT_API_KEY from .env — every mint
 * would then fail signature validation. Values already present in the
 * provided env win (explicit beats file).
 */
export function loadDotEnv(filePath) {
  const vars = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return vars;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[m[1]] = value;
  }
  return vars;
}

export async function runRender({ mode = 'host', env = process.env, workdir, report = mode === 'container', log = console.log } = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const dir =
    workdir ??
    env.LIVEKIT_WORK_DIR ??
    (mode === 'container' ? '/work' : path.resolve(scriptDir, '../../infra/livekit'));

  // Host mode: layer repo-root .env underneath the provided env so the
  // CLI one-liner sees the same secrets the compose stack runs with.
  if (mode === 'host') {
    const dotenv = loadDotEnv(path.resolve(scriptDir, '../../.env'));
    env = { ...dotenv, ...env };
  }

  const templatePath = path.join(dir, 'livekit.yaml.template');
  const outPath = path.join(dir, 'livekit.yaml');
  const lanIpPath = path.join(dir, '.lan-ip');
  const advertisedPath = path.join(dir, 'advertised.json');

  if (!fs.existsSync(templatePath)) {
    throw new Error(`LiveKit template missing: ${templatePath}`);
  }

  // ── LAN address ──
  const nodeIpEnv = env.LIVEKIT_NODE_IP ?? 'auto';
  let detectedLan = null;
  if (String(nodeIpEnv).trim().toLowerCase() === 'auto' || String(nodeIpEnv).trim() === '') {
    if (mode === 'host') {
      detectedLan = await detectLanIp();
      if (detectedLan) {
        fs.writeFileSync(lanIpPath, `${detectedLan}\n`, 'utf8');
        log(`[livekit-config] detected LAN IP ${detectedLan} (persisted to ${path.basename(lanIpPath)})`);
      }
    } else if (fs.existsSync(lanIpPath)) {
      const persisted = fs.readFileSync(lanIpPath, 'utf8').trim();
      if (isValidIpv4(persisted)) {
        detectedLan = persisted;
        log(`[livekit-config] using persisted LAN IP ${persisted}`);
      }
    }
  }

  // ── WAN address ──
  const externalIpEnv = env.LIVEKIT_EXTERNAL_IP ?? 'auto';
  let detectedWan = null;
  if (String(externalIpEnv).trim().toLowerCase() === 'auto' || String(externalIpEnv).trim() === '') {
    const { ip, via } = await detectWanIp();
    detectedWan = ip;
    if (ip) log(`[livekit-config] detected WAN IP ${ip} (via ${via})`);
  }

  const decision = decideAdvertisement({ nodeIpEnv, externalIpEnv, detectedLan, detectedWan });
  const range = parseUdpRange(env.LIVEKIT_UDP_PORT_RANGE);

  const rendered = renderTemplate(fs.readFileSync(templatePath, 'utf8'), {
    __LIVEKIT_API_KEY__: env.LIVEKIT_API_KEY || 'devkey',
    __LIVEKIT_API_SECRET__: env.LIVEKIT_API_SECRET || 'secret',
    __LIVEKIT_UDP_RANGE_START__: String(range.start),
    __LIVEKIT_UDP_RANGE_END__: String(range.end),
    __LIVEKIT_RTC_ADVERTISE__: buildRtcAdvertiseBlock(decision),
    __LIVEKIT_TURN_BLOCK__: buildTurnBlock({
      domain: env.LIVEKIT_TURN_DOMAIN,
      certFile: env.LIVEKIT_TURN_CERT_FILE,
      keyFile: env.LIVEKIT_TURN_KEY_FILE,
    }),
  });
  fs.writeFileSync(outPath, rendered, 'utf8');

  // ── advertised.json: state for the worker drift monitor + change
  //    detection so we only write Log rows when something changed. ──
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(advertisedPath, 'utf8'));
  } catch {
    /* first render or corrupt file — treat as changed */
  }
  const advertised = {
    version: 1,
    mode,
    lan: decision.lan,
    wan: decision.wan,
    ips: decision.ips,
    behind_nat: decision.behindNat,
    fallback_external: decision.fallbackExternal,
    udp_range: `${range.start}-${range.end}`,
    warnings: decision.warnings,
    rendered_at: new Date().toISOString(),
  };
  fs.writeFileSync(advertisedPath, `${JSON.stringify(advertised, null, 2)}\n`, 'utf8');

  const stateChanged =
    !previous ||
    previous.lan !== advertised.lan ||
    previous.wan !== advertised.wan ||
    previous.behind_nat !== advertised.behind_nat ||
    previous.fallback_external !== advertised.fallback_external ||
    JSON.stringify(previous.warnings ?? []) !== JSON.stringify(advertised.warnings);

  log(
    `[livekit-config] rendered ${path.basename(outPath)} — advertising ${
      decision.ips.length > 0 ? decision.ips.join(' + ') : 'STUN fallback'
    }${decision.behindNat ? ' (behind NAT)' : ''}, media UDP ${range.start}-${range.end}`,
  );
  for (const w of decision.warnings) {
    log(`[livekit-config] WARNING ${w}: ${REPORT_MESSAGES[`LIVEKIT_${w}`]?.() ?? w}`);
  }

  // ── Topology + problem rows to the platform Log. Container mode
  //    only (the host can't reach api:4000), and only on change so
  //    routine restarts don't pile up duplicate rows. ──
  if (report && stateChanged) {
    const apiBase = env.BBB_API_INTERNAL_URL || 'http://api:4000';
    const secret = env.INTERNAL_SERVICE_SECRET;
    const basePayload = {
      lan: decision.lan,
      wan: decision.wan,
      ips: decision.ips,
      behind_nat: decision.behindNat,
      udp_range: advertised.udp_range,
      mode,
    };
    if (decision.behindNat) {
      await reportToLog({
        apiBase,
        secret,
        code: 'LIVEKIT_BEHIND_NAT',
        message: REPORT_MESSAGES.LIVEKIT_BEHIND_NAT(decision, range),
        payload: basePayload,
        log,
      });
    }
    if (decision.fallbackExternal) {
      await reportToLog({
        apiBase,
        secret,
        code: 'LIVEKIT_ADVERTISE_FALLBACK',
        message: REPORT_MESSAGES.LIVEKIT_ADVERTISE_FALLBACK(),
        payload: basePayload,
        log,
      });
    }
    for (const w of decision.warnings) {
      const code = `LIVEKIT_${w}`;
      const make = REPORT_MESSAGES[code];
      if (make) {
        await reportToLog({ apiBase, secret, code, message: make(), payload: basePayload, log });
      }
    }
  }

  return { ...decision, outPath, advertisedPath, range, stateChanged };
}

// ─────────────────────────────────────────────────────────────────────
// CLI entrypoint
// ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const modeArg = process.argv.find((a) => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'host';
  runRender({ mode })
    .then((r) => {
      if (r.fallbackExternal) process.exitCode = 0; // degraded but rendered — livekit must still start
    })
    .catch((err) => {
      console.error('[livekit-config] FATAL:', err.message);
      process.exitCode = 1;
    });
}
