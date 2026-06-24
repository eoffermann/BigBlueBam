import { describe, it, expect } from 'vitest';
import { decodeYaml, encodeYaml, yamlHasAnchors } from './yaml.js';

describe('YAML codec', () => {
  it('parses to a plain JS value', () => {
    const { data } = decodeYaml('name: Gilligan\ncount: 7\nactive: true\n');
    expect(data).toEqual({ name: 'Gilligan', count: 7, active: true });
  });

  it('preserves comments + key order through a doc-aware round trip', () => {
    const src = '# castaways\nname: Skipper   # captain\nrole: leader\n';
    const { doc } = decodeYaml(src);
    const out = encodeYaml(undefined, doc);
    expect(out).toContain('# castaways');
    expect(out).toContain('# captain');
    expect(out.indexOf('name')).toBeLessThan(out.indexOf('role'));
  });

  it('reflects an edit applied through the Document', () => {
    const { doc } = decodeYaml('name: Skipper\nrole: leader\n');
    doc.set('role', 'captain');
    const out = encodeYaml(undefined, doc);
    expect(out).toContain('role: captain');
  });

  it('detects anchors / merge keys for the safe-subset gate', () => {
    expect(yamlHasAnchors('base: &b { x: 1 }\nuse: *b\n')).toBe(true);
    expect(yamlHasAnchors('defaults: &d\n  a: 1\nchild:\n  <<: *d\n')).toBe(true);
    expect(yamlHasAnchors('name: plain\ncount: 3\n')).toBe(false);
  });

  it('encodes a plain value to valid YAML when no doc is supplied', () => {
    const out = encodeYaml({ a: 1, b: ['x', 'y'] });
    const reparsed = decodeYaml(out).data;
    expect(reparsed).toEqual({ a: 1, b: ['x', 'y'] });
  });
});
