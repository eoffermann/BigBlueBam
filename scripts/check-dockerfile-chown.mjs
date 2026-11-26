#!/usr/bin/env node
// Fails when an app Dockerfile uses a recursive chown (`RUN chown -R`). On overlay storage a
// recursive chown copies every file up into a new layer, duplicating node_modules in the image
// and taking over an hour per build on slow Docker disks. Use `COPY --chown=bbam:bbam` instead
// and a non-recursive `RUN chown bbam:bbam /app` for the directory itself (#198).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = join(ROOT, 'apps');
const offenders = [];
for (const app of readdirSync(appsDir)) {
  const df = join(appsDir, app, 'Dockerfile');
  if (!existsSync(df)) continue;
  readFileSync(df, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*RUN\s+.*\bchown\s+-R\b/.test(line)) offenders.push(`apps/${app}/Dockerfile:${i + 1}: ${line.trim()}`);
    });
}
if (offenders.length) {
  console.error('Recursive chown found in app Dockerfiles (use COPY --chown=bbam:bbam instead, see #198):');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log('check-dockerfile-chown: OK (no recursive chown in app Dockerfiles)');
