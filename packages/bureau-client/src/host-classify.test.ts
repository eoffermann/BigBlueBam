import { describe, expect, it } from 'vitest';
import { classifyHost } from './host-classify.js';

// classifyHost feeds the page_host_kind field on Bureau call-failure
// reports — the field an engineer uses to tell LAN-side failures from
// remote-side failures in the SuperUser Log. Pure function, exhaustive
// pin of the RFC1918 / loopback / link-local / CGNAT boundaries.

describe('classifyHost', () => {
  it('loopback forms', () => {
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost('127.0.0.1')).toBe('loopback');
    expect(classifyHost('127.42.0.9')).toBe('loopback');
    expect(classifyHost('::1')).toBe('loopback');
    expect(classifyHost('[::1]')).toBe('loopback');
  });

  it('private ranges (RFC1918 + link-local + CGNAT)', () => {
    expect(classifyHost('10.0.0.1')).toBe('private-ip');
    expect(classifyHost('172.16.0.1')).toBe('private-ip');
    expect(classifyHost('172.31.255.254')).toBe('private-ip');
    expect(classifyHost('192.168.1.42')).toBe('private-ip');
    expect(classifyHost('169.254.10.10')).toBe('private-ip');
    expect(classifyHost('100.64.0.1')).toBe('private-ip');
    expect(classifyHost('100.127.255.254')).toBe('private-ip');
  });

  it('public addresses and the private-range boundaries', () => {
    expect(classifyHost('203.0.113.7')).toBe('public-ip');
    expect(classifyHost('8.8.8.8')).toBe('public-ip');
    expect(classifyHost('172.15.0.1')).toBe('public-ip'); // just below 172.16/12
    expect(classifyHost('172.32.0.1')).toBe('public-ip'); // just above
    expect(classifyHost('100.63.0.1')).toBe('public-ip'); // below CGNAT
    expect(classifyHost('100.128.0.1')).toBe('public-ip'); // above CGNAT
    expect(classifyHost('192.169.0.1')).toBe('public-ip');
  });

  it('hostnames and v6 literals', () => {
    expect(classifyHost('bigbluebam.com')).toBe('hostname');
    expect(classifyHost('my-nas.local')).toBe('hostname');
    expect(classifyHost('fd84:4fef::1')).toBe('hostname');
  });

  it('degenerate input', () => {
    expect(classifyHost('')).toBe('unknown');
    expect(classifyHost(null)).toBe('unknown');
    expect(classifyHost(undefined)).toBe('unknown');
    expect(classifyHost('300.1.1.1')).toBe('unknown');
  });
});
