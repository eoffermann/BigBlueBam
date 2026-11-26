// #252: find service code that reads an internal-secret header itself instead of going through the
// shared guard in @bigbluebam/service-health. Outgoing headers (`headers['x-internal-secret'] = ...`
// on a fetch) are not reads and are not reported.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const HEADER = String.raw`['"]x-internal-(?:secret|service-secret|token)['"]`;
// request.headers['x-internal-secret'], req.headers["x-internal-token"], headerValue(request, '...')
const READS = [
  new RegExp(String.raw`\b(?:request|req|raw)\.headers\[\s*${HEADER}\s*\](?!\s*=[^=])`, 'i'),
  new RegExp(String.raw`\bheaderValue\(\s*\w+\s*,\s*${HEADER}`, 'i'),
];

/** The shared guard itself, plus tracked exceptions (each with the issue that removes it). */
export const ALLOWED = new Map([
  ['packages/service-health/src/internal-secret.ts', 'the shared guard'],
  // Raw node:http, and the image does not build service-health yet: #277.
  ['apps/mcp-server/src/routes/tools-call.ts', '#277'],
]);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name)) out.push(p);
  }
  return out;
}

export function findInternalSecretHeaderReads(root) {
  const hits = [];
  for (const top of ['apps', 'packages']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const file of walk(src, [])) {
        const rel = relative(root, file).replace(/\\/g, '/');
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            if (READS.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    }
  }
  return hits;
}
