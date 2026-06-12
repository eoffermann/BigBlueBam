/**
 * Minimal STUN binding client — discovers this host's public (WAN) IP.
 *
 * TypeScript twin of the implementation in
 * scripts/livekit/render-config.mjs (which must stay zero-dep and
 * runnable in a bare node:22-alpine container, so it can't import from
 * the worker and the worker can't import a loose .mjs script — keep
 * the two in sync if the protocol handling ever changes; it's ~60
 * lines of RFC 5389 that hasn't changed since 2008).
 *
 * Used by the livekit-ip-drift job to answer "is LiveKit advertising a
 * public address that is no longer ours?".
 */
import dgram from 'node:dgram';

export const STUN_SERVERS: ReadonlyArray<readonly [string, number]> = [
  ['stun.l.google.com', 19302],
  ['global.stun.twilio.com', 3478],
];

export function isValidIpv4(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const parts = s.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Parse a STUN binding-success response; prefer XOR-MAPPED-ADDRESS. */
export function parseStunResponse(msg: Buffer, txid?: Buffer): string | null {
  if (!Buffer.isBuffer(msg) || msg.length < 20) return null;
  if (msg.readUInt16BE(0) !== 0x0101) return null; // binding success
  if (msg.readUInt32BE(4) !== 0x2112a442) return null; // magic cookie
  if (txid && !msg.subarray(8, 20).equals(txid)) return null;

  const bodyLen = msg.readUInt16BE(2);
  const end = Math.min(20 + bodyLen, msg.length);
  let xorIp: string | null = null;
  let plainIp: string | null = null;
  let off = 20;
  while (off + 4 <= end) {
    const attrType = msg.readUInt16BE(off);
    const attrLen = msg.readUInt16BE(off + 2);
    const val = msg.subarray(off + 4, Math.min(off + 4 + attrLen, end));
    if (val.length >= 8 && val[1] === 0x01) {
      if (attrType === 0x0020) {
        xorIp = [val[4]! ^ 0x21, val[5]! ^ 0x12, val[6]! ^ 0xa4, val[7]! ^ 0x42].join('.');
      } else if (attrType === 0x0001) {
        plainIp = [val[4], val[5], val[6], val[7]].join('.');
      }
    }
    off += 4 + attrLen + ((4 - (attrLen % 4)) % 4);
  }
  return xorIp ?? plainIp;
}

function stunQuery(host: string, port: number, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (v: string | null) => {
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
    req.writeUInt16BE(0x0001, 0);
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

/** Try each STUN server in order; null when none answered. */
export async function detectWanIpViaStun(): Promise<string | null> {
  for (const [host, port] of STUN_SERVERS) {
    const ip = await stunQuery(host, port);
    if (ip) return ip;
  }
  return null;
}
