// Port-aware public URL formation. Single source of truth used by:
//   - secrets.mjs::buildEnvConfig (BASE_URL / CORS_ORIGIN / PUBLIC_URL /
//     HELPDESK_URL / TRACKING_BASE_URL / PUBLIC_URL — anything written into
//     the .env that backends echo back to browsers)
//   - summary.mjs::printSummary ("here's where to log in" banner)
//
// Why this exists: the laptop-only version of the deploy flow assumed
// http://localhost (port 80) for "localhost" deployments and https://${domain}
// (port 443) for everything else. NAS operators (Synology, QNAP, TrueNAS,
// Unraid) almost always have something on 80/443 already and have to remap to
// HTTP_PORT=8080 / HTTPS_PORT=8443; without port awareness the API services
// have CORS_ORIGIN baked as http://localhost while the browser actually hits
// http://nas.local:8080, and login silently fails on cookie/CORS mismatches.
//
// Convention: when the host port is the default for the scheme (80 for http,
// 443 for https) we omit it from the URL — both for shorter banners and
// because some bits of the codebase compare CORS_ORIGIN against
// `request.headers.origin`, which a browser sends WITHOUT the default port.

/**
 * Choose http vs https for the public-facing URL.
 *
 * Defaults to https for any non-localhost domain (the laptop default), to
 * plain http for localhost. The advanced-port-mapping flow lets the operator
 * override this — a NAS at nas.local:8080 with no certificate is plain http.
 *
 * @param {string} domain - Hostname only (no scheme, no port).
 * @param {{ useTls?: boolean }} [opts]
 */
export function pickScheme(domain, opts = {}) {
  if (typeof opts.useTls === 'boolean') return opts.useTls ? 'https' : 'http';
  return domain === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(domain)
    ? 'http'
    : 'https';
}

/**
 * Build a public-facing base URL like "http://nas.local:8080" or
 * "https://bigbluebam.example.com". Default ports are omitted.
 *
 * @param {object} opts
 * @param {string} opts.domain - Hostname only.
 * @param {number} [opts.httpPort=80]
 * @param {number} [opts.httpsPort=443]
 * @param {boolean} [opts.useTls] - Override scheme inference.
 */
export function formatPublicUrl({ domain, httpPort = 80, httpsPort = 443, useTls } = {}) {
  const host = domain || 'localhost';
  const scheme = pickScheme(host, { useTls });
  const port = scheme === 'https' ? httpsPort : httpPort;
  const defaultPort = scheme === 'https' ? 443 : 80;
  const portSuffix = port && port !== defaultPort ? `:${port}` : '';
  return `${scheme}://${host}${portSuffix}`;
}

/**
 * Coerce a possibly-string port value to an integer in [1, 65535], or
 * return null if it doesn't look like a port. Used when reading values out
 * of a saved .deploy-state.json or the operator's free-text answers.
 */
export function parsePort(raw) {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}
