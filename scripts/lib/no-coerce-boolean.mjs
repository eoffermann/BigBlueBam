// #251: z.coerce.boolean() runs JS Boolean(), which is true for ANY non-empty string, so the
// string 'false' parses as true. It inverted query filters (#215, #231), sent Secure cookies over
// HTTP (COOKIE_SECURE=false), and failed open on BIN_ALLOW_UNSCANNED_ACCESS=false. The one owner
// of "string flag -> boolean" is packages/shared/src/schemas/common.ts (boolQueryParam for query
// strings, envBool for environment variables). This scan finds any new z.coerce.boolean in
// runtime or test source under apps/*/src and packages/*/src.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const PATTERN = /z\s*\.\s*coerce\s*\.\s*boolean\s*\(/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** True for a line that is only a comment (so prose that names the bad call is allowed). */
function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/** Every `file:line: text` under apps/*\/src and packages/*\/src that calls z.coerce.boolean. */
export function findCoerceBoolean(root) {
  const hits = [];
  for (const top of ['apps', 'packages']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const file of walk(src, [])) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!isCommentLine(line) && PATTERN.test(line)) {
            hits.push(`${relative(root, file).replace(/\\/g, '/')}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }
  return hits;
}
