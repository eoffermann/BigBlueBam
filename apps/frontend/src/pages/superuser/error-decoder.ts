/**
 * Translate raw system_errors rows into human-readable diagnostic
 * narrative. The motivating principle: an operator should be able to
 * open a row and understand what failed, where, and what to try next
 * WITHOUT reading the stack trace or knowing the codebase.
 *
 * Categories are recognized by pattern matching on (service, error_code,
 * message, payload). Anything we don't recognize falls back to a generic
 * "uncategorized error" so the raw fields are still visible.
 *
 * Add new categories by appending to DECODERS. Order matters: the first
 * matching decoder wins, so put specific ones above general ones.
 */

export interface ErrorRow {
  id: string;
  service: string;
  request_id: string | null;
  method: string | null;
  route: string | null;
  status_code: number | null;
  error_code: string | null;
  message: string;
  stack: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  user_id: string | null;
  org_id: string | null;
}

export interface DecodedError {
  /** Short, plain-English label shown as the row's badge / title. */
  category: string;
  /** A sentence or two describing what likely went wrong, in operator-
   *  facing language. No jargon unless it's actually meaningful. */
  summary: string;
  /** Actionable next step. Null when we don't have anything specific. */
  whatToTry: string | null;
  /** First user-code frame from the stack — "where the throw happened". */
  topFrame: string | null;
  /** Severity hint for color coding. */
  severity: 'config' | 'integration' | 'bug' | 'unknown';
  /** Optional structured callout (e.g. SMTP context). Rendered as a
   *  small definition list under the summary. */
  extras: Array<{ label: string; value: string }>;
}

// ─── Stack parsing ────────────────────────────────────────────────────

/**
 * Pull the first user-code frame out of a stack trace. Skips node:
 * internal frames and common third-party packages so the operator sees
 * "at processEmailJob (apps/worker/src/jobs/email.job.ts:62)" instead
 * of "at QueryReqWrap.onresolve (node:internal/dns/...)".
 *
 * Falls back to the very first frame when nothing more useful exists.
 */
function topUserFrame(stack: string | null): string | null {
  if (!stack) return null;
  const lines = stack.split('\n').slice(1); // first line is the message
  const ignore =
    /\bnode:internal\b|\/node_modules\/|node:.+\/|\bnode:dns\b|chromium|playwright/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    if (ignore.test(line)) continue;
    return line.replace(/^at\s+/, '');
  }
  // Nothing user-codey — return the first non-empty frame so the
  // operator at least sees SOMETHING.
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('at ')) return line.replace(/^at\s+/, '');
  }
  return null;
}

// ─── Decoders ─────────────────────────────────────────────────────────

interface Decoder {
  match: (e: ErrorRow) => boolean;
  decode: (e: ErrorRow) => Omit<DecodedError, 'topFrame'>;
}

const DECODERS: Decoder[] = [
  // 1. SMTP TLS / STARTTLS mismatch — the canonical "wrong version number"
  //    OpenSSL message. This is one of the most common SMTP misconfig
  //    failures and the entire point of the SMTP test button being added.
  {
    match: (e) =>
      e.error_code === 'ESOCKET' && /wrong version number/i.test(e.message),
    decode: (e) => {
      const cfg = (e.payload?.smtp_context as
        | { host?: string; port?: number; secure?: boolean; source?: string }
        | undefined) ?? {};
      const secure = cfg.secure;
      const port = cfg.port;
      const fix =
        secure === true
          ? `In SuperUser → Platform → SMTP, turn "Use TLS (secure)" OFF for port ${port ?? 587}. Port 465 is the ONLY port that wants TLS on; everything else uses STARTTLS (which nodemailer issues automatically).`
          : secure === false
            ? `In SuperUser → Platform → SMTP, turn "Use TLS (secure)" ON for port ${port ?? 465}. Plain SMTP was attempted on an SSL-only port. Or change the port to 587 and leave TLS off.`
            : `In SuperUser → Platform → SMTP, flip "Use TLS (secure)". Port 465 wants it on; 587 wants it off. Use the "Test connection" button to confirm before saving.`;
      return {
        category: 'SMTP TLS mismatch',
        summary:
          'The SMTP connection got handed plaintext bytes when it expected a TLS handshake (or vice versa). This is almost always the "Use TLS (secure)" checkbox set wrong for the chosen port.',
        whatToTry: fix,
        severity: 'config',
        extras: smtpContextExtras(cfg),
      };
    },
  },

  // 2. DNS lookup failed (EBADNAME, ENOTFOUND, or our explicit hostname
  //    case after the JSON wrapper bug).
  {
    match: (e) =>
      e.service === 'worker' &&
      /EBADNAME|ENOTFOUND|getaddrinfo|queryA/i.test(e.message),
    decode: (e) => {
      const cfg = (e.payload?.smtp_context as { host?: string } | undefined) ?? {};
      const host = cfg.host ?? '(unknown)';
      return {
        category: 'DNS lookup failed',
        summary: `The host "${host}" could not be resolved. Either the hostname is wrong, has invisible characters or quotes, or the worker container can't reach the upstream DNS.`,
        whatToTry: `Open SuperUser → Platform → SMTP and re-enter the SMTP Host carefully (no leading/trailing spaces, no quote characters). Use the "Test connection" button — it'll tell you in one second whether DNS works.`,
        severity: 'config',
        extras: smtpContextExtras(cfg),
      };
    },
  },

  // 3. SMTP auth rejected.
  {
    match: (e) =>
      e.error_code === 'EAUTH' ||
      /535|invalid login|authentication.*fail/i.test(e.message),
    decode: (e) => {
      const cfg = (e.payload?.smtp_context as { host?: string; port?: number } | undefined) ?? {};
      return {
        category: 'SMTP authentication rejected',
        summary:
          'The SMTP server rejected the credentials. Many providers require an "app password" or "API key" rather than the normal account password — Google, Microsoft, and most of the major hosted-mail providers do.',
        whatToTry: `Re-check the SMTP username (usually the full email address) and password in SuperUser → Platform → SMTP. If your provider supports app-passwords, generate one specifically for SMTP and use that here.`,
        severity: 'config',
        extras: smtpContextExtras(cfg),
      };
    },
  },

  // 4. Connection refused / timed out.
  {
    match: (e) => /ECONNREFUSED|ETIMEDOUT|ETIME\b|ECONNRESET/i.test(e.message),
    decode: (e) => {
      const isTimeout = /ETIMEDOUT|ETIME\b/i.test(e.message);
      return {
        category: isTimeout ? 'Network timeout' : 'Connection refused',
        summary: isTimeout
          ? 'The upstream service did not respond within the allowed time. The host may be unreachable from this deployment, or a firewall is in the way.'
          : 'Nothing was listening at the host/port we tried. Either the port is wrong, the service is down, or an outbound firewall blocks it.',
        whatToTry:
          'Confirm the host and port (SMTP especially: 465 for SSL, 587 for STARTTLS). If the deployment is behind an outbound firewall, ask your provider which port to use — many block 25 outright.',
        severity: 'integration',
        extras: extractNetworkContext(e),
      };
    },
  },

  // 5. Validation errors (these are 4xx, not 5xx, but if any leak through
  //    as 5xx it's a bug worth surfacing distinctly).
  {
    match: (e) =>
      e.error_code === 'VALIDATION_ERROR' ||
      /validation.*fail|expected.*received/i.test(e.message),
    decode: () => ({
      category: 'Validation error',
      summary:
        'A request reached the server with a body or query the route considered invalid. If this is showing up as a 5xx, the route is letting a validation throw escape instead of returning a 4xx.',
      whatToTry:
        'Look at the route handler indicated by the top frame and confirm it catches its validator throws and turns them into a 400 response.',
      severity: 'bug',
      extras: [],
    }),
  },

  // 6. Postgres errors.
  {
    match: (e) =>
      /postgresError|PostgresError|sqlstate|relation .* does not exist|column .* does not exist/i.test(
        e.message,
      ),
    decode: (e) => {
      const isMissing = /relation .* does not exist|column .* does not exist/i.test(
        e.message,
      );
      return {
        category: isMissing ? 'Database schema mismatch' : 'Database error',
        summary: isMissing
          ? 'The query referenced a table or column the database does not have. This usually means a migration has not been applied here yet.'
          : 'A database query failed. The full SQLSTATE and message are in the raw error below.',
        whatToTry: isMissing
          ? 'Run `docker compose run --rm migrate` (local) or check that the Railway migrate service has applied every migration through this commit.'
          : null,
        severity: isMissing ? 'config' : 'bug',
        extras: [],
      };
    },
  },

  // 7. Bullmq / job failures generically.
  {
    match: (e) => e.service === 'worker',
    decode: (e) => {
      const queue = (e.payload?.queue as string | undefined) ?? 'unknown';
      const jobName = (e.payload?.job_name as string | undefined) ?? '(no name)';
      return {
        category: `Worker job failed`,
        summary: `A background job on the "${queue}" queue (${jobName}) threw an unhandled error. The job has been retried per its BullMQ policy and will appear here for every retry.`,
        whatToTry:
          'Open the row and read the stack — the top frame points to the file that threw. Most worker failures are config or integration problems (SMTP misconfigured, third-party API key wrong, etc.).',
        severity: 'bug',
        extras: [],
      };
    },
  },

  // 8. Generic API 5xx.
  {
    match: (e) => e.service === 'api' && (e.status_code ?? 0) >= 500,
    decode: () => ({
      category: 'Server error',
      summary:
        'An api request resulted in a 5xx response. The top frame in the stack is where the throw happened.',
      whatToTry:
        'Search the route in this codebase (the route column shows the path template) and add or improve the try/catch around the failing call.',
      severity: 'bug',
      extras: [],
    }),
  },
];

function smtpContextExtras(cfg: {
  host?: string;
  port?: number;
  secure?: boolean;
  source?: string;
}): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (cfg.host) out.push({ label: 'SMTP host', value: cfg.host });
  if (cfg.port != null) out.push({ label: 'SMTP port', value: String(cfg.port) });
  if (cfg.secure != null)
    out.push({ label: 'Use TLS (secure)', value: cfg.secure ? 'on' : 'off' });
  if (cfg.source) out.push({ label: 'Config source', value: cfg.source });
  return out;
}

function extractNetworkContext(e: ErrorRow): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const cfg = e.payload?.smtp_context as
    | { host?: string; port?: number }
    | undefined;
  if (cfg?.host) out.push({ label: 'Host', value: cfg.host });
  if (cfg?.port != null) out.push({ label: 'Port', value: String(cfg.port) });
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────

export function decodeError(e: ErrorRow): DecodedError {
  for (const d of DECODERS) {
    if (d.match(e)) {
      const r = d.decode(e);
      return { ...r, topFrame: topUserFrame(e.stack) };
    }
  }
  return {
    category: 'Uncategorized error',
    summary:
      'No specific decoder matched. The raw error message and stack are below — the top frame points to where the throw originated.',
    whatToTry: null,
    severity: 'unknown',
    topFrame: topUserFrame(e.stack),
    extras: [],
  };
}
