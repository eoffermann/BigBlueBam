// #252: find service code that reads an internal-secret header itself instead of going through the
// shared guard in @bigbluebam/service-health. Outgoing headers (`headers['x-internal-secret'] = ...`
// on a fetch) are not reads and are not reported.
//
// #306: the header name can also arrive through a constant (`const H = 'x-internal-secret'`, local
// or exported from another module), read as `request.headers[H]`. The scan first collects every
// identifier bound to a secret header name anywhere under apps/*/src and packages/*/src, then
// treats a computed read keyed by one of those identifiers exactly like the literal form.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const HEADER_NAME = String.raw`x-internal-(?:secret|service-secret|token)`;
const HEADER = String.raw`['"\`]${HEADER_NAME}['"\`]`;
// const H = 'x-internal-secret'; export const H: string = "x-internal-token" as const;
const BINDING = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>\[\]| ]+)?=\s*${HEADER}`,
  'gi',
);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The read patterns for one key expression (a quoted header name, or a bound identifier). */
function readPatterns(key) {
  return [
    // request.headers['x-internal-secret'], req.headers[H], raw.headers[H], ctx.headers[H]
    new RegExp(String.raw`\.headers\[\s*${key}\s*\](?!\s*=[^=])`, 'i'),
    // headerValue(request, 'x-internal-token') / headerValue(request, H)
    new RegExp(String.raw`\bheaderValue\(\s*\w+\s*,\s*${key}\s*[,)]`, 'i'),
    // request.headers.get('x-internal-secret') / headers.get(H) on a Fetch Headers object
    new RegExp(String.raw`\.headers\.get\(\s*${key}\s*\)`, 'i'),
    // const { 'x-internal-secret': s } = request.headers / const { [H]: s } = req.headers
    new RegExp(String.raw`(?:${key}|\[\s*${key}\s*\])\s*:\s*[\w$]+\s*[,}][^=]*=\s*[\w$.]*headers\b`, 'i'),
  ];
}

/** The shared guard itself (its framework-free core and the Fastify wrapper). No exceptions. */
export const ALLOWED = new Map([
  ['packages/service-health/src/internal-peer.ts', 'the shared guard core'],
  ['packages/service-health/src/internal-secret.ts', 'the shared guard'],
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

function sourceFiles(root) {
  const files = [];
  for (const top of ['apps', 'packages']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const file of walk(src, [])) {
        files.push({ file, rel: relative(root, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') });
      }
    }
  }
  return files;
}

/** Every identifier bound to an internal-secret header name in any scanned source file. */
export function secretHeaderConstants(files) {
  const names = new Set();
  for (const { text } of files) {
    for (const m of text.matchAll(BINDING)) names.add(m[1]);
  }
  return names;
}

export function findInternalSecretHeaderReads(root) {
  const files = sourceFiles(root);
  const keys = [HEADER, ...[...secretHeaderConstants(files)].map((n) => String.raw`\b${escapeRe(n)}\b`)];
  const reads = keys.flatMap(readPatterns);
  const hits = [];
  for (const { rel, text } of files) {
    if (ALLOWED.has(rel)) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (reads.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}
