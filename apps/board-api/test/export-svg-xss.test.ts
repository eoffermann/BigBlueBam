import { describe, it, expect } from 'vitest';
import { sceneToSvg } from '../src/services/export.service.js';

// The SVG export is built from untyped scene JSON that any board editor
// controls. Colors went into attributes after only a typeof check, and points
// were cast rather than checked, so a crafted element broke out of its
// attribute and the exported SVG ran script when opened.

const scene = (el: Record<string, unknown>) => ({ elements: [el], appState: {}, files: {} }) as never;
const base = { x: 10, y: 10, width: 50, height: 20 };

describe('sceneToSvg', () => {
  it.each([
    ['strokeColor', '#fff" onload="alert(1)'],
    ['backgroundColor', 'red"/><script>alert(1)</script><rect fill="'],
    ['strokeColor', 'url(javascript:alert(1))'],
  ])('drops a hostile %s', (field, value) => {
    const svg = sceneToSvg(scene({ ...base, type: 'rectangle', [field]: value }));
    expect(svg).not.toMatch(/onload|<script|javascript:/i);
  });

  it('keeps legitimate colors', () => {
    for (const c of ['#1e1e1e', '#ffffff80', 'rgb(10, 20, 30)', 'hsla(120, 50%, 50%, 0.5)', 'transparent', 'red']) {
      expect(sceneToSvg(scene({ ...base, type: 'rectangle', strokeColor: c }))).toContain(`stroke="${c}"`);
    }
  });

  it('coerces every path coordinate to a number', () => {
    const svg = sceneToSvg(
      scene({ ...base, type: 'line', points: [[0, 0], ['5" onmouseover="alert(1)', 3]] }),
    );
    expect(svg).not.toMatch(/onmouseover/);
    expect(svg).toMatch(/d="M 10 10 L 10 13"/);
  });
});
