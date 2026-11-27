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
  return scanSources(root, (line) => PATTERN.test(line), {});
}

// #302: an env flag compared to a literal by hand (`process.env.BBB_RLS_ENFORCE === '1'`) is the
// same bug class: `true` / `yes` / `on` silently mean off. Read the flag through envBool in the
// service's env.ts, or envFlag() from @bigbluebam/shared outside one.
const RAW_ENV_FLAG =
  /\benv\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*['"`][^'"`]+['"`]\s*\])\s*[!=]==?\s*['"`](?:1|0|true|false|yes|no|on|off)['"`]|['"`](?:1|0|true|false|yes|no|on|off)['"`]\s*[!=]==?\s*\w*\.?env\s*(?:\.|\[)/i;

/**
 * Files allowed to compare an env flag by hand, with the reason. Only test tooling that does not
 * depend on @bigbluebam/shared and whose flag can only ENABLE something on an exact '1' (any other
 * spelling leaves the guarded action off, which is the safe side).
 */
export const RAW_ENV_FLAG_EXEMPT = {
  'apps/e2e/src/auth/test-users.ts': 'E2E_SEED_GENERIC_DATA: test tooling, exact 1 opts in to writes',
  'packages/docs-capture/src/environment.ts': 'SHOTS_ALLOW_PROD: capture tooling, exact 1 opts in',
  'packages/docs-capture/src/runner.ts': 'SHOTS_REUSE_E2E_AUTH: capture tooling, exact 1 opts in',
};

/** Every `file:line: text` under apps/*\/src and packages/*\/src comparing an env flag to a literal. */
export function findRawEnvFlagCompares(root, exempt = RAW_ENV_FLAG_EXEMPT) {
  return scanSources(root, (line) => RAW_ENV_FLAG.test(line), exempt);
}

function scanSources(root, matches, exempt) {
  const hits = [];
  for (const top of ['apps', 'packages']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const file of walk(src, [])) {
        const rel = relative(root, file).replace(/\\/g, '/');
        if (Object.hasOwn(exempt, rel)) continue;
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!isCommentLine(line) && matches(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }
  return hits;
}
