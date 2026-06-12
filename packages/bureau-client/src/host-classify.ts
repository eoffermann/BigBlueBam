/**
 * Classify how the browser is addressing this deployment — by loopback,
 * a private (LAN) IP, a public IP, or a DNS hostname.
 *
 * Included in every Bureau call-failure report so an engineer reading a
 * BUREAU_CONNECT_FAILED row in the SuperUser Log can tell at a glance
 * which network path the failing client was on (e.g. "page_host_kind:
 * private-ip means a LAN client — check the LAN advertisement / the
 * LIVEKIT_BEHIND_NAT topology row" vs "public-ip / hostname means a
 * remote client — check forwards or TURN"). Diagnosis context only;
 * never used to make connection decisions (ICE owns those).
 */

export type HostKind = 'loopback' | 'private-ip' | 'public-ip' | 'hostname' | 'unknown';

export function classifyHost(hostname: string | null | undefined): HostKind {
  if (!hostname) return 'unknown';
  const h = hostname.trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return 'loopback';

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) {
    // Not an IPv4 literal. IPv6 literals other than loopback get
    // 'hostname' treatment too — for diagnosis purposes "addressed by
    // name or v6" vs "addressed by v4 literal" is the useful split.
    return 'hostname';
  }
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return 'unknown';
  const [a, b] = octets;

  if (a === 127) return 'loopback';
  if (a === 10) return 'private-ip';
  if (a === 172 && b! >= 16 && b! <= 31) return 'private-ip';
  if (a === 192 && b === 168) return 'private-ip';
  if (a === 169 && b === 254) return 'private-ip'; // link-local
  if (a === 100 && b! >= 64 && b! <= 127) return 'private-ip'; // CGNAT
  return 'public-ip';
}
