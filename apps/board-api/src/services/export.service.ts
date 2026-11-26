/**
 * Board export service -- generates SVG and PNG from board elements.
 *
 * Excalidraw scenes cannot be rendered server-side without a browser, so
 * we build a lightweight SVG representation that faithfully positions each
 * element and renders text content.  This is suitable for thumbnails and
 * quick previews; pixel-perfect fidelity requires client-side rendering
 * via @excalidraw/utils exportToSvg.
 *
 * PNG export uses `sharp` to rasterize the generated SVG into pixel data.
 * Basic shapes, text, and lines are rendered accurately; hand-drawn
 * Excalidraw strokes and custom fonts are approximated.
 */

import sharp from 'sharp';
import type { SceneData } from '../ws/persistence.js';

// ---------------------------------------------------------------------------
// SVG builder helpers
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBBox(elements: Record<string, unknown>[]): BBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const el of elements) {
    const x = typeof el.x === 'number' ? el.x : 0;
    const y = typeof el.y === 'number' ? el.y : 0;
    const w = typeof el.width === 'number' ? el.width : 100;
    const h = typeof el.height === 'number' ? el.height : 100;

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  }

  // Add padding
  const pad = 20;
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function renderElement(el: Record<string, unknown>): string {
  const type = el.type as string | undefined;
  const x = typeof el.x === 'number' ? el.x : 0;
  const y = typeof el.y === 'number' ? el.y : 0;
  const w = typeof el.width === 'number' ? el.width : 100;
  const h = typeof el.height === 'number' ? el.height : 40;
  const stroke = typeof el.strokeColor === 'string' ? el.strokeColor : '#1e1e1e';
  const bg = typeof el.backgroundColor === 'string' ? el.backgroundColor : 'transparent';
  const opacity = typeof el.opacity === 'number' ? el.opacity / 100 : 1;
  const angle = typeof el.angle === 'number' ? el.angle : 0;

  const transform = angle !== 0
    ? ` transform="rotate(${(angle * 180) / Math.PI} ${x + w / 2} ${y + h / 2})"`
    : '';

  switch (type) {
    case 'rectangle':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}" stroke="${stroke}" stroke-width="1" opacity="${opacity}" rx="3"${transform}/>`;

    case 'diamond':
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${bg}" stroke="${stroke}" stroke-width="1" opacity="${opacity}"${transform}/>`;

    case 'ellipse':
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${bg}" stroke="${stroke}" stroke-width="1" opacity="${opacity}"${transform}/>`;

    case 'text': {
      const text = typeof el.text === 'string' ? el.text : '';
      const fontSize = typeof el.fontSize === 'number' ? el.fontSize : 16;
      return `<text x="${x}" y="${y + fontSize}" font-size="${fontSize}" fill="${stroke}" opacity="${opacity}" font-family="sans-serif"${transform}>${escapeXml(text)}</text>`;
    }

    case 'arrow':
    case 'line': {
      const points = Array.isArray(el.points) ? el.points as number[][] : [];
      if (points.length < 2) {
        return `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="${stroke}" stroke-width="1" opacity="${opacity}"${transform}/>`;
      }
      const d = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x + (p[0] ?? 0)} ${y + (p[1] ?? 0)}`)
        .join(' ');
      const marker = type === 'arrow' ? ' marker-end="url(#arrowhead)"' : '';
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1" opacity="${opacity}"${marker}${transform}/>`;
    }

    case 'freedraw': {
      const pts = Array.isArray(el.points) ? el.points as number[][] : [];
      if (pts.length < 2) return '';
      const d = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x + (p[0] ?? 0)} ${y + (p[1] ?? 0)}`)
        .join(' ');
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1" opacity="${opacity}"${transform}/>`;
    }

    case 'image':
      // Images cannot be embedded without the binary data; render a placeholder
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f0f0f0" stroke="#ccc" stroke-width="1" stroke-dasharray="4" opacity="${opacity}"${transform}/>`;

    case 'frame':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#6b7280" stroke-width="2" stroke-dasharray="8 4" opacity="${opacity}"${transform}/>`;

    default:
      // Unknown element -- render a generic rect outline
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#d1d5db" stroke-width="1" opacity="${opacity}"${transform}/>`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a board scene to an SVG string.
 */
export function sceneToSvg(scene: SceneData, boardName?: string): string {
  const rawElements = (scene.elements ?? []) as Record<string, unknown>[];
  const liveElements = rawElements.filter((el) => el.isDeleted !== true);

  if (liveElements.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><text x="400" y="300" text-anchor="middle" font-family="sans-serif" fill="#9ca3af">Empty board${boardName ? `: ${escapeXml(boardName)}` : ''}</text></svg>`;
  }

  const bbox = computeBBox(liveElements);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bbox.minX} ${bbox.minY} ${width} ${height}">`);
  parts.push('<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#1e1e1e"/></marker></defs>');
  parts.push(`<rect x="${bbox.minX}" y="${bbox.minY}" width="${width}" height="${height}" fill="white"/>`);

  for (const el of liveElements) {
    parts.push(renderElement(el));
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Generate a small thumbnail SVG (max 300x200) from a full scene.
 */
export function sceneToThumbnailSvg(scene: SceneData): string {
  const full = sceneToSvg(scene);
  // Rewrite the root svg to have a fixed small size but preserve the viewBox
  return full.replace(
    /width="[^"]*" height="[^"]*"/,
    'width="300" height="200"',
  );
}

/**
 * Convert a board scene to a PNG Buffer via sharp.
 *
 * Sharp natively supports SVG input (via librsvg/resvg internally).
 * The resulting PNG faithfully renders rectangles, ellipses, text, lines,
 * and other basic SVG elements produced by `sceneToSvg`. Complex
 * Excalidraw-specific features (hand-drawn strokes, custom fonts) are
 * approximated; pixel-perfect fidelity still requires client-side
 * rendering via @excalidraw/utils.
 */
export async function sceneToPng(
  scene: SceneData,
  boardName?: string,
): Promise<Buffer> {
  const svg = sceneToSvg(scene, boardName);
  const svgBuffer = Buffer.from(svg, 'utf-8');

  const png = await sharp(svgBuffer)
    .png()
    .toBuffer();

  return png;
}
