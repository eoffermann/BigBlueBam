// Pure transform from infra/nginx/nginx-with-site.conf (the compose source) to
// infra/nginx/nginx.railway.conf. Extracted from scripts/gen-railway-configs.mjs so it
// can be unit tested without writing files (see scripts/lib/railway-nginx.test.mjs).
//
// Transforms, in order:
//   1. `proxy_pass http://<known-host>:<port>` -> `<host>.railway.internal:<port|8080>`.
//   1b. `set $<var> <known-host>:<port>;` (a runtime-resolved upstream, written so nginx
//       boots even when that upstream is down) -> `<host>.railway.internal:<port|8080>`.
//   1c. `resolver 127.0.0.11 ...;` (Docker's embedded DNS, which does not exist on
//       Railway) -> `resolver __RESOLVER__ ...;`, filled in by infra/nginx/entrypoint.sh.
//   2. `__HTTP_LISTEN__` / `__TLS_LISTEN_BLOCK__` placeholders and any `listen N;` -> 8080.
//   3. A server-level `resolver __RESOLVER__ valid=10s;` after the first listen.
//   4. Static `proxy_pass http://<host>.railway.internal:<port>[/uri];` -> a `set`
//      variable plus an explicit rewrite, so nginx re-resolves at request time.
// Comment lines are never rewritten.

export const RAILWAY_DYNAMIC_PORT = 8080;

const isComment = (line) => /^\s*#/.test(line);

function mapLines(text, fn) {
  return text
    .split('\n')
    .map((line) => (isComment(line) ? line : fn(line)))
    .join('\n');
}

/**
 * @param {string} source nginx config text (any line endings)
 * @param {{ validHosts: Iterable<string>, appHosts: Iterable<string> }} hosts
 *   validHosts: every catalog service name; appHosts: services that bind $PORT (8080).
 */
export function transformNginxForRailway(source, { validHosts, appHosts }) {
  const valid = new Set(validHosts);
  const apps = new Set(appHosts);
  const railwayPortFor = (host, port) => (apps.has(host) ? String(RAILWAY_DYNAMIC_PORT) : port);
  const counts = {
    rewrittenProxyPass: 0,
    rewrittenSetUpstream: 0,
    rewrittenResolver: 0,
    rewrittenListen: 0,
    rewrittenVariable: 0,
  };

  // CRLF -> LF first: a lone `\r` is its own line boundary in `m` mode and once welded
  // `listen 8080;` onto a comment line, freezing production (see gen-railway-configs.mjs).
  let out = source.replace(/\r\n?/g, '\n');

  // 1. proxy_pass upstreams.
  out = out.replace(/proxy_pass(\s+)http:\/\/([a-z][a-z0-9-]*):(\d+)/gi, (match, ws, host, port) => {
    if (!valid.has(host)) return match;
    counts.rewrittenProxyPass++;
    return `proxy_pass${ws}http://${host}.railway.internal:${railwayPortFor(host, port)}`;
  });

  // 1b. Runtime-resolved upstream variables: `set $x host:port;` (optionally quoted).
  const setRe = /^(\s*set\s+\$[A-Za-z_][A-Za-z0-9_]*\s+)(["']?)([a-z][a-z0-9-]*):(\d+)\2(\s*;.*)$/;
  out = mapLines(out, (line) => {
    const m = line.match(setRe);
    if (!m) return line;
    const [, prefix, quote, host, port, rest] = m;
    if (!valid.has(host)) return line;
    counts.rewrittenSetUpstream++;
    return `${prefix}${quote}${host}.railway.internal:${railwayPortFor(host, port)}${quote}${rest}`;
  });

  // 1c. Docker's embedded DNS resolver -> the entrypoint-filled placeholder.
  out = mapLines(out, (line) => {
    const replaced = line.replace(/^(\s*resolver\s+)127\.0\.0\.11(?=[\s;])/, '$1__RESOLVER__');
    if (replaced !== line) counts.rewrittenResolver++;
    return replaced;
  });

  // 2. Listen placeholders and literal listen directives.
  out = out.replace(/^\s*__HTTP_LISTEN__\s*$/m, `    listen ${RAILWAY_DYNAMIC_PORT};`);
  out = out.replace(/^\s*__TLS_LISTEN_BLOCK__\s*$/m, '');
  counts.rewrittenListen++;
  const listenRewriteRe = /(\blisten\s+)(\d+)([^;]*);/g;
  out = mapLines(out, (line) =>
    line.replace(listenRewriteRe, (match, prefix, port, suffix) => {
      if (port === String(RAILWAY_DYNAMIC_PORT)) return match;
      counts.rewrittenListen++;
      return `${prefix}${RAILWAY_DYNAMIC_PORT}${suffix};`;
    }),
  );

  // 3. Server-level resolver after the first real listen.
  const resolverRe = /(\blisten\s+\d+[^;]*;)/;
  let resolverInjected = false;
  out = mapLines(out, (line) => {
    if (resolverInjected) return line;
    const replaced = line.replace(resolverRe, `$1\n    resolver __RESOLVER__ valid=10s;`);
    if (replaced !== line) resolverInjected = true;
    return replaced;
  });

  // 4. Static railway.internal proxy_pass -> set variable + explicit rewrite.
  const lines = out.split('\n');
  const resultLines = [];
  let currentLoc = null;
  let braceDepth = 0;
  let locBraceDepth = 0;
  let varSeq = 0;
  const locRe = /^(\s*)location\s+([^\s{]+(?:\s+[^\s{]+)*)\s*\{\s*$/;
  const closeRe = /^\s*}\s*$/;
  const openRe = /\{/;
  const proxyRe =
    /^(\s*)proxy_pass\s+http:\/\/([a-z][a-z0-9-]*\.railway\.internal):(\d+)(\/[^\s;]*)?;(\s*)$/;
  for (const line of lines) {
    const mLoc = line.match(locRe);
    if (mLoc) {
      currentLoc = mLoc[2];
      locBraceDepth = braceDepth;
      braceDepth++;
      resultLines.push(line);
      continue;
    }
    if (closeRe.test(line)) {
      braceDepth = Math.max(0, braceDepth - 1);
      if (currentLoc && braceDepth === locBraceDepth) currentLoc = null;
      resultLines.push(line);
      continue;
    }
    if (openRe.test(line)) braceDepth++;
    const mProxy = line.match(proxyRe);
    if (mProxy && currentLoc) {
      const [, indent, host, port, uri, trailing] = mProxy;
      const varName = `$rw_upstream_${++varSeq}`;
      resultLines.push(`${indent}set ${varName} "${host}";`);
      if (uri && uri !== '') {
        const locPath = currentLoc.replace(/^=\s+/, '');
        const locEsc = locPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        resultLines.push(`${indent}rewrite ^${locEsc}(.*)$ ${uri}$1 break;`);
      }
      resultLines.push(`${indent}proxy_pass http://${varName}:${port};${trailing ?? ''}`);
      counts.rewrittenVariable++;
      continue;
    }
    resultLines.push(line);
  }
  out = resultLines.join('\n');

  return { out, counts };
}
