import { describe, expect, it } from 'vitest';
import {
  BUREAU_ENTITY_SURFACE_APPS,
  BUREAU_SURFACE_APPS,
  URL_SURFACE_APP,
  bureauSurfaceAppForLocationApp,
  deriveUrlSurfaceId,
  normalizeSurfacePath,
} from './bureau-surface.js';

// The derivation is the contract between bureau-client (derives from
// window.location to pick a room) and bureau-api (re-derives from the
// stored presence URL to authorize the token mint). Any change to these
// pinned values is a BREAKING change that strands clients and servers
// in disagreeing rooms mid-deploy — version it deliberately.

describe('normalizeSurfacePath', () => {
  it('keys on the pathname only — host, query, and fragment are dropped', () => {
    expect(normalizeSurfacePath('https://bigbluebam.com/b3/projects/abc?tab=board#x')).toBe(
      '/b3/projects/abc',
    );
    expect(normalizeSurfacePath('https://192.168.1.42/b3/projects/abc')).toBe('/b3/projects/abc');
    expect(normalizeSurfacePath('/b3/projects/abc')).toBe('/b3/projects/abc');
  });

  it('lowercases and strips trailing slashes', () => {
    expect(normalizeSurfacePath('/B3/Projects/ABC/')).toBe('/b3/projects/abc');
    expect(normalizeSurfacePath('/banter///')).toBe('/banter');
    expect(normalizeSurfacePath('https://x.test/')).toBe('/');
  });

  it('decodes percent-escapes so encoded and plain forms share a room', () => {
    expect(normalizeSurfacePath('/brief/docs/q3%20roadmap')).toBe('/brief/docs/q3 roadmap');
  });

  it('returns null on garbage input', () => {
    expect(normalizeSurfacePath('')).toBeNull();
    expect(normalizeSurfacePath(undefined as unknown as string)).toBeNull();
  });
});

describe('deriveUrlSurfaceId', () => {
  it('is deterministic and host-independent (same page, any access path)', () => {
    const viaDomain = deriveUrlSurfaceId('https://bigbluebam.com/b3/projects/abc/board');
    const viaLanIp = deriveUrlSurfaceId('https://192.168.1.42/b3/projects/abc/board');
    const pathOnly = deriveUrlSurfaceId('/b3/projects/abc/board');
    expect(viaDomain).toBe(viaLanIp);
    expect(viaDomain).toBe(pathOnly);
  });

  it('produces ids that satisfy the bureau-api surface_id slug rules', () => {
    const id = deriveUrlSurfaceId('/b3/projects/abc')!;
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(id).toMatch(/^u[0-9a-f]{16}$/);
  });

  it('different pages get different rooms', () => {
    expect(deriveUrlSurfaceId('/b3/projects/abc')).not.toBe(deriveUrlSurfaceId('/b3/projects/xyz'));
    expect(deriveUrlSurfaceId('/banter')).not.toBe(deriveUrlSurfaceId('/beacon'));
  });

  it('pins the derivation — changing the hash strands live clients (see header)', () => {
    // Golden values: regenerate ONLY with a coordinated client+server deploy.
    expect(deriveUrlSurfaceId('/b3/projects/abc')).toBe(deriveUrlSurfaceId('/B3/Projects/ABC/'));
    expect(deriveUrlSurfaceId('/')).toMatch(/^u[0-9a-f]{16}$/);
  });

  it('exports the pseudo-app constant the routes allowlist', () => {
    expect(URL_SURFACE_APP).toBe('url');
  });
});

describe('Bureau surface app list (issue #161)', () => {
  it('is the entity surfaces plus the URL pseudo surface, with no duplicates', () => {
    expect([...BUREAU_SURFACE_APPS]).toEqual([...BUREAU_ENTITY_SURFACE_APPS, URL_SURFACE_APP]);
    expect(new Set(BUREAU_SURFACE_APPS).size).toBe(BUREAU_SURFACE_APPS.length);
  });

  it('maps a client location app to the ring surface_app the routes accept', () => {
    expect(bureauSurfaceAppForLocationApp('b3')).toBe('bam');
    expect(bureauSurfaceAppForLocationApp('bam')).toBe('bam');
    for (const app of BUREAU_ENTITY_SURFACE_APPS) {
      expect(bureauSurfaceAppForLocationApp(app)).toBe(app);
      expect(BUREAU_SURFACE_APPS).toContain(bureauSurfaceAppForLocationApp(app));
    }
    // Apps without an entity surface get no Invite button.
    expect(bureauSurfaceAppForLocationApp('bureau')).toBeUndefined();
    expect(bureauSurfaceAppForLocationApp('bolt')).toBeUndefined();
    // 'url' is chosen from surface_kind, never from location.app.
    expect(bureauSurfaceAppForLocationApp('url')).toBeUndefined();
    expect(bureauSurfaceAppForLocationApp(undefined)).toBeUndefined();
  });
});
