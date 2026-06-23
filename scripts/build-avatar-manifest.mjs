#!/usr/bin/env node
// Builds assets/default-avatars/manifest.json from the PNG files in that
// directory. The manifest is served at /avatars/manifest.json (see the nginx
// /avatars/ location) and consumed at runtime by the Settings avatar picker.
//
// Filenames follow `<category>-<NN>.png` (e.g. cat-01.png, woman-12.png).
// Re-run after adding/removing avatars:  node scripts/build-avatar-manifest.mjs
import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets', 'default-avatars');

// Human label per filename prefix. Unknown prefixes fall back to a title-cased
// version of the prefix so a new category works without editing this file.
const LABELS = { cat: 'Cats', dog: 'Dogs', man: 'Men', woman: 'Women' };
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const files = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .sort();

const avatars = files.map((file) => {
  const id = file.replace(/\.png$/i, '');
  const category = id.replace(/-\d+$/, '');
  return { id, file, category, url: `/avatars/${file}` };
});

const categories = [...new Set(avatars.map((a) => a.category))].map((key) => ({
  key,
  label: LABELS[key] ?? titleCase(key),
  count: avatars.filter((a) => a.category === key).length,
}));

const manifest = { categories, avatars };
const out = join(DIR, 'manifest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `[avatar-manifest] wrote ${out} — ${avatars.length} avatars across ${categories.length} categories (${categories
    .map((c) => `${c.key}:${c.count}`)
    .join(', ')})`,
);
