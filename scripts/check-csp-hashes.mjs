#!/usr/bin/env node
/**
 * check-csp-hashes.mjs - guard the suite's Content-Security-Policy in every
 * nginx config (BugHunt FE-3).
 *
 * WHY THIS EXISTS. infra/nginx/nginx.conf serves the site-root redirect as an
 * INLINE <script> inside `return 200 '...'`. The suite CSP uses
 * `script-src 'self'` with no 'unsafe-inline', so that one script is
 * authorized by a sha256 hash instead. The hash is a literal string in the
 * config. If anyone edits the script and does not regenerate it, nginx still
 * starts, `nginx -t` still passes, the page still returns 200, and the browser
 * silently refuses to run the redirect, leaving every visitor to the site root
 * on a blank page. That is the same class of failure as the CRLF that welded
 * `listen 8080;` onto a comment: valid config, running server, broken product,
 * no error anywhere obvious.
 *
 * The check parses each config (quote- and comment-aware, so braces inside the
 * inline JavaScript do not confuse it), resolves the policy nginx will
 * actually EMIT for each location (server-level `set $bbb_csp`, a location's
 * own `set $bbb_csp` override, and nginx's rule that a location declaring any
 * add_header inherits none from the server), then asserts, per config:
 *
 *   1. every inline <script> served by a `return NNN '...'` page has its
 *      sha256 in the script-src of the policy emitted for that location;
 *   2. every 'sha256-...' declared anywhere matches a script actually served
 *      (no stale hashes left behind after an edit);
 *   3. no emitted policy puts 'unsafe-inline' (or 'unsafe-eval') in its
 *      effective script-src, which would silently void the whole CSP;
 *   4. the SPA document location (the `.../index.html$` regex, which serves
 *      every SPA page and every try_files deep-link fallback) emits a CSP.
 *
 * Usage:
 *   node scripts/check-csp-hashes.mjs                 (checks all three configs)
 *   node scripts/check-csp-hashes.mjs path/to/a.conf  (checks only the given files)
 * Exit code 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIGS = [
  'infra/nginx/nginx.conf',
  'infra/nginx/nginx-with-site.conf',
  'infra/nginx/nginx.railway.conf',
];

const CSP_VAR = '$bbb_csp';

// ─── nginx tokenizer / parser ────────────────────────────────────────────

/** nginx's in-quote unescaping (ngx_conf_read_token): \" \' \\ \t \r \n. */
function unescapeNginx(raw) {
  return raw.replace(/\\(["'\\trn])/g, (_, c) => ({ t: '\t', r: '\r', n: '\n' })[c] ?? c);
}

/**
 * Parse nginx config text into a tree of { name, args, line, block? }.
 * Quote-aware (single and double, with backslash escapes) and comment-aware.
 */
export function parseNginx(text) {
  const root = { name: '<root>', args: [], line: 0, block: [] };
  const stack = [root];
  let words = [];
  let wordLine = 0;
  let cur = null; // current unquoted word being built
  let line = 1;
  const flushWord = () => {
    if (cur !== null) {
      words.push(cur);
      cur = null;
    }
  };
  const startDirective = () => {
    if (words.length === 0) wordLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line++;
    if (ch === '#' && cur === null) {
      while (i < text.length && text[i] !== '\n') i++;
      line++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flushWord();
      startDirective();
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\' && j + 1 < text.length) {
          raw += text[j] + text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === '\n') line++;
        raw += text[j];
        j++;
      }
      if (j >= text.length) throw new Error(`unterminated ${ch} quote starting on line ${wordLine}`);
      words.push(unescapeNginx(raw));
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    if (ch === ';' || ch === '{' || ch === '}') {
      flushWord();
      const top = stack[stack.length - 1];
      if (ch === ';') {
        if (words.length) top.block.push({ name: words[0], args: words.slice(1), line: wordLine });
      } else if (ch === '{') {
        const node = { name: words[0] ?? '', args: words.slice(1), line: wordLine, block: [] };
        top.block.push(node);
        stack.push(node);
      } else {
        if (stack.length === 1) throw new Error(`unbalanced } on line ${line}`);
        stack.pop();
      }
      words = [];
      continue;
    }
    if (cur === null) {
      startDirective();
      cur = '';
    }
    cur += ch;
  }
  flushWord();
  if (stack.length !== 1) throw new Error('unbalanced { (missing closing brace)');
  return root;
}

// ─── CSP helpers ─────────────────────────────────────────────────────────

/** Parse a CSP string into a Map(directive -> source list). */
export function parseCsp(policy) {
  const map = new Map();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!map.has(name)) map.set(name, tokens.slice(1));
  }
  return map;
}

/** The sources that govern <script> elements: script-src, else default-src. */
export function effectiveScriptSrc(policy) {
  const csp = parseCsp(policy);
  return csp.get('script-src-elem') ?? csp.get('script-src') ?? csp.get('default-src') ?? null;
}

export function sha256Source(scriptText) {
  return `sha256-${createHash('sha256').update(scriptText, 'utf8').digest('base64')}`;
}

/** Inline (no src=) <script> bodies inside an HTML string. */
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

// ─── analysis ────────────────────────────────────────────────────────────

function cspFromAddHeaders(directives, cspVarValue) {
  const h = directives.find((d) => d.name === 'add_header' && /^content-security-policy$/i.test(d.args[0] ?? ''));
  if (!h) return { declared: false, value: '' };
  const raw = h.args[1] ?? '';
  return { declared: true, value: raw === CSP_VAR ? cspVarValue : raw, line: h.line };
}

/**
 * Analyse one config's text. Returns { errors: string[], info: string[] }.
 * `label` is only used in messages.
 */
export function analyzeConfig(text, label = 'config') {
  const errors = [];
  const info = [];
  let tree;
  try {
    tree = parseNginx(text);
  } catch (e) {
    return { errors: [`${label}: cannot parse: ${e.message}`], info };
  }

  const servers = [];
  const walkServers = (node) => {
    for (const d of node.block ?? []) {
      if (d.name === 'server') servers.push(d);
      else if (d.block) walkServers(d);
    }
  };
  walkServers(tree);

  const servedHashes = new Set();
  const declaredHashes = []; // { hash, line }
  const collectDeclared = (value, line) => {
    for (const m of value.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)) declaredHashes.push({ hash: m[1], line });
  };

  const checkScriptSrc = (policy, where) => {
    if (!policy) return;
    const src = effectiveScriptSrc(policy);
    if (!src) {
      // e.g. the marketing site's deliberate `frame-ancestors *`-only policy:
      // it does not restrict scripts, so there is nothing to void.
      info.push(`${label}: ${where} emits a CSP without script-src/default-src (scripts not restricted there)`);
      return;
    }
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'"]) {
      if (src.includes(bad)) {
        errors.push(
          `${label}: ${where} emits a CSP whose script-src contains ${bad}. That voids the XSS backstop ` +
            `(an injected script or handler would run). Allow a specific inline script by its sha256 instead.`,
        );
      }
    }
  };

  for (const server of servers) {
    const serverSets = server.block.filter((d) => d.name === 'set' && d.args[0] === CSP_VAR);
    const serverCspVar = serverSets.length ? serverSets[serverSets.length - 1].args[1] ?? '' : '';
    for (const s of serverSets) collectDeclared(s.args[1] ?? '', s.line);
    const serverAddHeaders = server.block.filter((d) => d.name === 'add_header');
    for (const h of serverAddHeaders) if (/^content-security-policy$/i.test(h.args[0] ?? '')) collectDeclared(h.args[1] ?? '', h.line);

    const serverPolicy = cspFromAddHeaders(serverAddHeaders, serverCspVar);
    if (serverPolicy.declared) checkScriptSrc(serverPolicy.value, `server block (line ${server.line})`);

    const visitLocations = (node, inheritedAddHeaders, inheritedVar) => {
      for (const loc of node.block ?? []) {
        if (loc.name !== 'location') continue;
        const where = `location ${loc.args.join(' ')} (line ${loc.line})`;
        const locSets = loc.block.filter((d) => d.name === 'set' && d.args[0] === CSP_VAR);
        const cspVar = locSets.length ? locSets[locSets.length - 1].args[1] ?? '' : inheritedVar;
        for (const s of locSets) collectDeclared(s.args[1] ?? '', s.line);
        const ownAddHeaders = loc.block.filter((d) => d.name === 'add_header');
        for (const h of ownAddHeaders) if (/^content-security-policy$/i.test(h.args[0] ?? '')) collectDeclared(h.args[1] ?? '', h.line);
        // nginx: a level that declares ANY add_header inherits none from above.
        const effectiveAddHeaders = ownAddHeaders.length ? ownAddHeaders : inheritedAddHeaders;
        const policy = cspFromAddHeaders(effectiveAddHeaders, cspVar);
        const emitted = policy.declared ? policy.value : '';
        if (ownAddHeaders.length || locSets.length) checkScriptSrc(emitted, where);

        // (1) inline scripts served by this location must be allowed by hash.
        for (const ret of loc.block.filter((d) => d.name === 'return' && d.args.length >= 2)) {
          for (const body of inlineScripts(ret.args[1])) {
            const hash = sha256Source(body);
            servedHashes.add(hash);
            const src = emitted ? effectiveScriptSrc(emitted) : null;
            if (!emitted) {
              info.push(`${label}: ${where} serves an inline script with no CSP at all (nothing to verify)`);
            } else if (!src || !src.includes(`'${hash}'`)) {
              errors.push(
                `${label}: ${where} serves an inline <script> that its CSP does not allow.\n` +
                  `  The browser will refuse to run it (for the root redirect: a blank page at /).\n` +
                  `    computed: '${hash}'\n` +
                  `    script-src: ${src ? src.join(' ') : '(none)'}\n` +
                  `  Fix: put the computed hash in that location's script-src.`,
              );
            } else {
              info.push(`${label}: ${where} inline script matches its CSP hash ('${hash}')`);
            }
          }
        }

        // (4) the SPA document location must emit a CSP.
        if (loc.args.some((a) => /index\\?\.html\$?$/.test(a)) && !emitted) {
          errors.push(
            `${label}: ${where} serves every SPA document but emits NO Content-Security-Policy. It declares ` +
              `its own add_header, so it inherits none from the server block; add ` +
              `\`add_header Content-Security-Policy ${CSP_VAR} always;\` to it.`,
          );
        }

        visitLocations(loc, effectiveAddHeaders, cspVar);
      }
    };
    visitLocations(server, serverAddHeaders, serverCspVar);
  }

  // (2) no stale hashes.
  for (const { hash, line } of declaredHashes) {
    if (!servedHashes.has(hash)) {
      errors.push(
        `${label}: line ${line} declares '${hash}' but no inline script this config serves hashes to it ` +
          `(stale after an edit?). Served script hashes: ${[...servedHashes].map((h) => `'${h}'`).join(', ') || '(none)'}`,
      );
    }
  }

  return { errors, info };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main(argv) {
  const files = argv.length ? argv : DEFAULT_CONFIGS.map((f) => join(ROOT, f));
  let failed = false;
  for (const file of files) {
    const label = relative(process.cwd(), file) || file;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.error(`[check-csp-hashes] FAIL: cannot read ${label}`);
      failed = true;
      continue;
    }
    const { errors, info } = analyzeConfig(text, label);
    for (const line of info) console.log(`[check-csp-hashes] ${line}`);
    if (errors.length) {
      failed = true;
      for (const e of errors) console.error(`[check-csp-hashes] FAIL: ${e}`);
    } else {
      console.log(`[check-csp-hashes] OK: ${label}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
