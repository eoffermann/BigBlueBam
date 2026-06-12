/**
 * Unit tests for the pure half of render-config.mjs.
 * Runner: `node --test scripts/livekit/` (zero-dep node:test — no vitest
 * here because this script must stay runnable in a bare node:22-alpine
 * container, and its tests should run anywhere the script does).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidIpv4,
  parseUdpRange,
  decideAdvertisement,
  buildRtcAdvertiseBlock,
  buildTurnBlock,
  renderTemplate,
  parseStunResponse,
} from './render-config.mjs';

// ── isValidIpv4 ──────────────────────────────────────────────────────

test('isValidIpv4 accepts dotted quads and rejects junk', () => {
  assert.equal(isValidIpv4('192.168.1.42'), true);
  assert.equal(isValidIpv4('203.0.113.7'), true);
  assert.equal(isValidIpv4('256.1.1.1'), false);
  assert.equal(isValidIpv4('1.2.3'), false);
  assert.equal(isValidIpv4('example.com'), false);
  assert.equal(isValidIpv4(''), false);
  assert.equal(isValidIpv4(null), false);
});

// ── parseUdpRange ────────────────────────────────────────────────────

test('parseUdpRange parses well-formed ranges', () => {
  assert.deepEqual(parseUdpRange('51000-51100'), { start: 51000, end: 51100 });
  assert.deepEqual(parseUdpRange('60000-60050'), { start: 60000, end: 60050 });
});

test('parseUdpRange falls back on malformed / inverted / privileged input', () => {
  const fb = { start: 51000, end: 51100 };
  assert.deepEqual(parseUdpRange('banana'), fb);
  assert.deepEqual(parseUdpRange('51100-51000'), fb); // inverted
  assert.deepEqual(parseUdpRange('80-90'), fb); // below 1024
  assert.deepEqual(parseUdpRange(''), fb);
  assert.deepEqual(parseUdpRange(undefined), fb);
});

// ── decideAdvertisement matrix ───────────────────────────────────────

test('both addresses detected and different → both advertised, behind NAT', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'auto',
    externalIpEnv: 'auto',
    detectedLan: '192.168.1.42',
    detectedWan: '203.0.113.7',
  });
  assert.deepEqual(d.ips, ['192.168.1.42', '203.0.113.7']);
  assert.equal(d.behindNat, true);
  assert.equal(d.fallbackExternal, false);
  assert.deepEqual(d.warnings, []);
});

test('LAN equals WAN (cloud host with public interface) → single entry, not behind NAT', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'auto',
    externalIpEnv: 'auto',
    detectedLan: '203.0.113.7',
    detectedWan: '203.0.113.7',
  });
  assert.deepEqual(d.ips, ['203.0.113.7']);
  assert.equal(d.behindNat, false);
});

test('WAN detection failed → LAN-only with WAN_DETECT_FAILED warning', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'auto',
    externalIpEnv: 'auto',
    detectedLan: '192.168.1.42',
    detectedWan: null,
  });
  assert.deepEqual(d.ips, ['192.168.1.42']);
  assert.equal(d.behindNat, false);
  assert.ok(d.warnings.includes('WAN_DETECT_FAILED'));
});

test('no persisted LAN ip (container, never host-rendered) → WAN-only with LAN_IP_UNKNOWN', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'auto',
    externalIpEnv: 'auto',
    detectedLan: null,
    detectedWan: '203.0.113.7',
  });
  assert.deepEqual(d.ips, ['203.0.113.7']);
  assert.ok(d.warnings.includes('LAN_IP_UNKNOWN'));
});

test('explicit overrides beat detection', () => {
  const d = decideAdvertisement({
    nodeIpEnv: '10.0.0.5',
    externalIpEnv: '198.51.100.9',
    detectedLan: '192.168.1.42',
    detectedWan: '203.0.113.7',
  });
  assert.deepEqual(d.ips, ['10.0.0.5', '198.51.100.9']);
});

test('none suppresses a side without warnings', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'auto',
    externalIpEnv: 'none',
    detectedLan: '192.168.1.42',
    detectedWan: '203.0.113.7', // detection result ignored because intent is none
  });
  assert.deepEqual(d.ips, ['192.168.1.42']);
  assert.equal(d.behindNat, false);
  assert.deepEqual(d.warnings, []);
});

test('nothing usable anywhere → fallback to LiveKit boot-time STUN', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'none',
    externalIpEnv: 'auto',
    detectedLan: null,
    detectedWan: null,
  });
  assert.equal(d.fallbackExternal, true);
  assert.deepEqual(d.ips, []);
});

test('invalid explicit IPs are ignored with their own warning', () => {
  const d = decideAdvertisement({
    nodeIpEnv: 'not-an-ip',
    externalIpEnv: '999.1.1.1',
    detectedLan: null,
    detectedWan: null,
  });
  assert.equal(d.fallbackExternal, true);
  assert.ok(d.warnings.includes('LAN_IP_INVALID'));
  assert.ok(d.warnings.includes('WAN_IP_INVALID'));
});

// ── yaml block builders ──────────────────────────────────────────────

test('buildRtcAdvertiseBlock: LAN known → node_ip + full ICE + STUN', () => {
  const block = buildRtcAdvertiseBlock({
    lan: '192.168.1.42',
    wan: '203.0.113.7',
    useStun: true,
  });
  assert.match(block, /^ {2}node_ip: 192\.168\.1\.42$/m);
  assert.match(block, /^ {2}use_external_ip: false$/m);
  assert.match(block, /^ {2}use_ice_lite: false$/m);
  assert.match(block, /^ {2}stun_servers:$/m);
  assert.match(block, /^ {4}- stun\.l\.google\.com:19302$/m);
  // This LiveKit build rejects nat_1to1_ips at parse time — never emit it.
  assert.doesNotMatch(block, /nat_1to1_ips/);
});

test('buildRtcAdvertiseBlock: LAN unknown → boot-time STUN advertisement, still full ICE', () => {
  const block = buildRtcAdvertiseBlock({ lan: null, wan: '203.0.113.7', useStun: true });
  assert.match(block, /^ {2}use_external_ip: true$/m);
  assert.match(block, /^ {2}use_ice_lite: false$/m);
  assert.doesNotMatch(block, /node_ip/);
});

test('buildRtcAdvertiseBlock: air-gapped (LIVEKIT_EXTERNAL_IP=none) → no stun_servers', () => {
  const block = buildRtcAdvertiseBlock({ lan: '10.0.0.5', wan: null, useStun: false });
  assert.match(block, /^ {2}node_ip: 10\.0\.0\.5$/m);
  assert.match(block, /^ {2}use_ice_lite: false$/m);
  assert.doesNotMatch(block, /stun_servers/);
});

test('decideAdvertisement: useStun reflects the WAN intent', () => {
  const on = decideAdvertisement({
    nodeIpEnv: 'auto', externalIpEnv: 'auto', detectedLan: '10.0.0.5', detectedWan: null,
  });
  assert.equal(on.useStun, true);
  const off = decideAdvertisement({
    nodeIpEnv: 'auto', externalIpEnv: 'none', detectedLan: '10.0.0.5', detectedWan: null,
  });
  assert.equal(off.useStun, false);
});

test('buildTurnBlock renders only when domain + cert + key are all present', () => {
  const off = buildTurnBlock({ domain: '', certFile: '', keyFile: '' });
  assert.match(off, /turn: disabled/);
  assert.doesNotMatch(off, /^turn:$/m);

  const partial = buildTurnBlock({ domain: 'turn.example.com', certFile: '', keyFile: '' });
  assert.match(partial, /turn: disabled/);

  const on = buildTurnBlock({
    domain: 'turn.example.com',
    certFile: '/certs/fullchain.pem',
    keyFile: '/certs/privkey.pem',
  });
  assert.match(on, /^turn:$/m);
  assert.match(on, /domain: turn\.example\.com/);
  assert.match(on, /tls_port: 5349/);
});

// ── renderTemplate ───────────────────────────────────────────────────

test('renderTemplate substitutes every placeholder and round-trips values', () => {
  const out = renderTemplate('a __X__ b __Y__ c __X__', { __X__: '1', __Y__: '2' });
  assert.equal(out, 'a 1 b 2 c 1');
});

test('renderTemplate throws on a leftover __LIVEKIT_ placeholder (template drift guard)', () => {
  assert.throws(
    () => renderTemplate('rtc:\n__LIVEKIT_RTC_ADVERTISE__\n', {}),
    /unsubstituted placeholder __LIVEKIT_RTC_ADVERTISE__/,
  );
});

// ── parseStunResponse ────────────────────────────────────────────────

function buildStunSuccess({ txid, ip, attrType = 0x0020 }) {
  const cookie = [0x21, 0x12, 0xa4, 0x42];
  const octets = ip.split('.').map(Number);
  const attrVal = Buffer.alloc(8);
  attrVal[0] = 0x00;
  attrVal[1] = 0x01; // IPv4
  attrVal.writeUInt16BE(attrType === 0x0020 ? 51000 ^ 0x2112 : 51000, 2);
  for (let i = 0; i < 4; i++) {
    attrVal[4 + i] = attrType === 0x0020 ? octets[i] ^ cookie[i] : octets[i];
  }
  const msg = Buffer.alloc(20 + 4 + 8);
  msg.writeUInt16BE(0x0101, 0); // binding success
  msg.writeUInt16BE(12, 2); // body length
  msg.writeUInt32BE(0x2112a442, 4);
  txid.copy(msg, 8);
  msg.writeUInt16BE(attrType, 20);
  msg.writeUInt16BE(8, 22);
  attrVal.copy(msg, 24);
  return msg;
}

test('parseStunResponse extracts the IP from XOR-MAPPED-ADDRESS', () => {
  const txid = Buffer.from('0102030405060708090a0b0c', 'hex');
  const msg = buildStunSuccess({ txid, ip: '203.0.113.7' });
  assert.equal(parseStunResponse(msg, txid), '203.0.113.7');
});

test('parseStunResponse accepts legacy MAPPED-ADDRESS', () => {
  const txid = Buffer.from('0102030405060708090a0b0c', 'hex');
  const msg = buildStunSuccess({ txid, ip: '198.51.100.9', attrType: 0x0001 });
  assert.equal(parseStunResponse(msg, txid), '198.51.100.9');
});

test('parseStunResponse rejects wrong transaction id, type, and runts', () => {
  const txid = Buffer.from('0102030405060708090a0b0c', 'hex');
  const other = Buffer.from('ffffffffffffffffffffffff', 'hex');
  const msg = buildStunSuccess({ txid, ip: '203.0.113.7' });
  assert.equal(parseStunResponse(msg, other), null);
  const wrongType = Buffer.from(msg);
  wrongType.writeUInt16BE(0x0111, 0); // binding error response
  assert.equal(parseStunResponse(wrongType, txid), null);
  assert.equal(parseStunResponse(Buffer.alloc(4), txid), null);
});
