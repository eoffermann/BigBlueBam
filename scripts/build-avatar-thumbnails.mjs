#!/usr/bin/env node
// Generates small WebP thumbnails for the default avatars so the picker grid
// (a few hundred images) and ordinary in-app avatar renders (24–80px) don't
// each download a ~370KB 512px PNG. The 512px PNGs stay in the repo as the
// source of truth; only the thumbnails are served to the browser.
//
// Output: assets/default-avatars/thumbs/<name>.webp at THUMB_SIZE px.
// 192px covers every in-app size up to the 80px Settings preview at 2x DPI,
// and a 192px WebP is ~4–8KB (vs ~370KB), a ~50–90x reduction.
//
// Re-run after adding/removing avatars (then re-run build-avatar-manifest.mjs):
//   node scripts/build-avatar-thumbnails.mjs && node scripts/build-avatar-manifest.mjs
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const THUMB_SIZE = 192;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets', 'default-avatars');
const THUMBS = join(DIR, 'thumbs');

mkdirSync(THUMBS, { recursive: true });

const pngs = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .sort();

console.log(`[avatar-thumbs] generating ${pngs.length} ${THUMB_SIZE}px WebP thumbnails…`);
let totalSrc = 0;
let totalOut = 0;
let done = 0;

for (const file of pngs) {
  const src = join(DIR, file);
  const out = join(THUMBS, file.replace(/\.png$/i, '.webp'));
  totalSrc += statSync(src).size;
  await sharp(src)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
    .webp({ quality: 80 })
    .toFile(out);
  totalOut += statSync(out).size;
  done += 1;
  if (done % 50 === 0 || done === pngs.length) {
    console.log(`[avatar-thumbs]   ${done}/${pngs.length}`);
  }
}

console.log(
  `[avatar-thumbs] done: ${(totalSrc / 1048576).toFixed(1)}MB of PNG -> ${(totalOut / 1048576).toFixed(
    2,
  )}MB of WebP (avg ${Math.round(totalOut / pngs.length / 1024)}KB/thumb)`,
);
