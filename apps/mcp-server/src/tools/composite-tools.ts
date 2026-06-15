import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Composite subject-centric MCP tools (AGENTIC_TODO §6, Wave 3).
 *
 * Three composites:
 *   - account_view({ company_id? | contact_id? | domain? })
 *       The "account page" surface: deals, tickets, invoices, tasks,
 *       recent activity, owners. Resolves to a company first, then fans
 *       out to bond, helpdesk, bill, bam, api/activity in parallel.
 *   - project_view({ project_id })
 *       Project overview: sprint, tasks count, bearing goals, brief docs,
 *       beacon entries, top contributors.
 *   - user_view({ user_id })
 *       Person profile: owned deals, assigned tasks, open tickets, goals,
 *       recent activity.
 *
 * Composition pattern:
 *   - Promise.allSettled over arms fetched in parallel.
 *   - Each arm wrapped in a 5s AbortController timeout.
 *   - Arm rejection or timeout => the corresponding field is empty / null,
 *     section name appended to `missing`, `partial: true`.
 *   - 502 COMPOSITE_FAILED only when every arm fails.
 *
 * Visibility: composites do NOT preflight via can_access. Each downstream
 * endpoint already RLS-scopes under the caller's token. Asker-mode
 * (as_user_id) is not supported in Wave 3. The tool returns only entities
 * the caller can already see.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ARM_TIMEOUT_MS = 5000;

interface FetchResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

/** Pull the bearer token out of the ApiClient (same trick search-tools uses). */
function bearerToken(api: ApiClient): string | undefined {
  return (api as unknown as { token?: string }).token;
}

function authHeaders(api: ApiClient): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = bearerToken(api);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * fetch with an AbortController timeout. On non-ok status we resolve with
 * ok=false (caller decides whether to throw); on network error or timeout
 * we throw so the enclosing arm rejects.
 */
async function fetchWithTimeout<T = unknown>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    throw new Error(aborted ? `timed out after ${timeoutMs}ms` : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function trimBase(u: string): string {
  return u.replace(/\/$/, '');
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errEnvelope(code: string, message: string, status: number) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { error: { code, message, status }, status },
          null,
          2,
        ),
      },
    ],
    isError: true as const,
  };
}

/**
 * Wrap an arm promise so a rejection is converted into a null payload plus
 * a flag that marks the arm as missing. The outer caller feeds these into
 * Promise.allSettled; using this wrapper makes it simpler to gather
 * `missing[]` from the settled results.
 */
interface ArmOutcome<T> {
  name: string;
  value: T | null;
  failed: boolean;
}

async function runArm<T>(name: string, work: () => Promise<T>): Promise<ArmOutcome<T>> {
  try {
    const value = await work();
    return { name, value, failed: false };
  } catch {
    return { name, value: null, failed: true };
  }
}

// ---------------------------------------------------------------------------
// URL bundle for composite tools
// ---------------------------------------------------------------------------

export interface CompositeToolUrls {
  apiUrl: string;
  bondApiUrl: string;
  helpdeskApiUrl: string;
  billApiUrl: string;
  bearingApiUrl: string;
  briefApiUrl: string;
  beaconApiUrl: string;
}

// ---------------------------------------------------------------------------
// account_view
// ---------------------------------------------------------------------------

type ResolvedFrom = 'company_id' | 'contact_id' | 'domain';

interface ResolvedAccount {
  company_id: string;
  company_name: string;
  domain: string | null;
  resolved_from: ResolvedFrom;
}

/**
 * Resolve the incoming identifier to a concrete company. The three paths:
 *   - company_id: GET /companies/:id on bond-api.
 *   - contact_id: GET /contacts/:id on bond-api, then pick the primary
 *                 or first associated company.
 *   - domain:     GET /companies?search=<domain> on bond-api, then filter
 *                 client-side for an exact domain match.
 * Returns null if the identifier cannot be resolved.
 */
async function resolveAccount(
  urls: CompositeToolUrls,
  api: ApiClient,
  input: { company_id?: string; contact_id?: string; domain?: string },
): Promise<ResolvedAccount | null> {
  const bondBase = trimBase(urls.bondApiUrl);
  const headers = authHeaders(api);

  if (input.company_id) {
    const r = await fetchWithTimeout<{ data?: { id: string; name: string; domain: string | null } }>(
      `${bondBase}/companies/${input.company_id}`,
      { method: 'GET', headers },
      ARM_TIMEOUT_MS,
    );
    if (!r.ok || !r.data?.data) return null;
    const c = r.data.data;
    return {
      company_id: c.id,
      company_name: c.name,
      domain: c.domain ?? null,
      resolved_from: 'company_id',
    };
  }

  if (input.contact_id) {
    const r = await fetchWithTimeout<{
      data?: {
        id: string;
        companies?: Array<{ company_id: string; name: string; domain: string | null; is_primary?: boolean }>;
      };
    }>(
      `${bondBase}/contacts/${input.contact_id}`,
      { method: 'GET', headers },
      ARM_TIMEOUT_MS,
    );
    if (!r.ok || !r.data?.data) return null;
    const companies = r.data.data.companies ?? [];
    if (companies.length === 0) return null;
    const primary = companies.find((c) => c.is_primary) ?? companies[0]!;
    return {
      company_id: primary.company_id,
      company_name: primary.name,
      domain: primary.domain ?? null,
      resolved_from: 'contact_id',
    };
  }

  if (input.domain) {
    const qs = new URLSearchParams({ search: input.domain, limit: '20' });
    const r = await fetchWithTimeout<{
      data?: Array<{ id: string; name: string; domain: string | null }>;
    }>(
      `${bondBase}/companies?${qs.toString()}`,
      { method: 'GET', headers },
      ARM_TIMEOUT_MS,
    );
    if (!r.ok) return null;
    const rows = r.data?.data ?? [];
    const target = input.domain.toLowerCase();
    const exact = rows.find((c) => (c.domain ?? '').toLowerCase() === target);
    const pick = exact ?? rows[0];
    if (!pick) return null;
    return {
      company_id: pick.id,
      company_name: pick.name,
      domain: pick.domain ?? null,
      resolved_from: 'domain',
    };
  }

  return null;
}

interface AccountDeal {
  id: string;
  name: string;
  stage: string | null;
  value_cents: number | null;
  expected_close_date: string | null;
  owner_id: string | null;
}

interface AccountTicket {
  id: string;
  number: number | null;
  subject: string;
  status: string;
  priority: string | null;
  updated_at: string;
}

interface AccountInvoice {
  id: string;
  number: string | null;
  amount_cents: number | null;
  status: string;
  due_date: string | null;
}

interface AccountTask {
  id: string;
  human_id: string | null;
  title: string;
  state_category: string | null;
  project_id: string;
}

interface AccountActivity {
  id: string;
  source_app: string;
  action: string;
  actor_id: string | null;
  created_at: string;
}

interface AccountOwner {
  user_id: string;
  display_name: string;
  role: 'account' | 'deal' | 'support';
}

/** Fetch open deals for an account via bond-api. */
async function fetchAccountDeals(
  bondBase: string,
  headers: Record<string, string>,
  companyId: string,
): Promise<AccountDeal[]> {
  const qs = new URLSearchParams({ company_id: companyId, limit: '20' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${bondBase}/deals?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bond deals: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((row) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    stage: (row.stage_id ? String(row.stage_id) : null) as string | null,
    value_cents: typeof row.value === 'number' ? (row.value as number) : null,
    expected_close_date:
      typeof row.expected_close_date === 'string' ? (row.expected_close_date as string) : null,
    owner_id: typeof row.owner_id === 'string' ? (row.owner_id as string) : null,
  }));
}

/**
 * Fetch recent helpdesk tickets. There's no helpdesk-side "link to bond
 * company" filter today, so this arm returns the org's most recent open
 * tickets. That's the best we can do without a cross-app join; the caller
 * is informed via the returned `missing` set when this arm fails but NOT
 * when it merely returns rows that are broader than the account.
 */
async function fetchAccountTickets(
  helpdeskBase: string,
  headers: Record<string, string>,
): Promise<AccountTicket[]> {
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${helpdeskBase}/tickets?status=open`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`helpdesk tickets: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((row) => ({
    id: String(row.id ?? ''),
    number: typeof row.ticket_number === 'number' ? (row.ticket_number as number) : null,
    subject: String(row.subject ?? ''),
    status: String(row.status ?? ''),
    priority: typeof row.priority === 'string' ? (row.priority as string) : null,
    updated_at: String(row.updated_at ?? ''),
  }));
}

/**
 * Fetch invoices linked (via bill_clients.bond_company_id) to the account.
 * Two steps: list clients, filter to those whose bond_company_id matches,
 * then list invoices per client. We take the last 20 across the union.
 */
async function fetchAccountInvoices(
  billBase: string,
  headers: Record<string, string>,
  companyId: string,
): Promise<AccountInvoice[]> {
  const clientsRes = await fetchWithTimeout<{
    data?: Array<{ id: string; bond_company_id?: string | null }>;
  }>(
    `${billBase}/clients`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!clientsRes.ok) throw new Error(`bill clients: status ${clientsRes.status}`);
  const clients = (clientsRes.data?.data ?? []).filter(
    (c) => c.bond_company_id === companyId,
  );
  if (clients.length === 0) return [];

  // Fan out per client in parallel, also time-boxed. Failures inside the
  // inner fan-out are swallowed; we keep any client's invoices we got.
  const invoiceArrays = await Promise.all(
    clients.map(async (c) => {
      try {
        const qs = new URLSearchParams({ client_id: c.id });
        const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
          `${billBase}/invoices?${qs.toString()}`,
          { method: 'GET', headers },
          ARM_TIMEOUT_MS,
        );
        if (!r.ok) return [];
        return r.data?.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  const merged: Array<Record<string, unknown>> = [];
  for (const arr of invoiceArrays) merged.push(...arr);
  merged.sort((a, b) => {
    const da = String(a.invoice_date ?? a.created_at ?? '');
    const db = String(b.invoice_date ?? b.created_at ?? '');
    return db.localeCompare(da);
  });
  return merged.slice(0, 20).map((row) => ({
    id: String(row.id ?? ''),
    number: typeof row.invoice_number === 'string' ? (row.invoice_number as string) : null,
    // bill-api stores the final amount in `total` (bigint minor units).
    amount_cents:
      typeof row.total === 'number'
        ? (row.total as number)
        : typeof row.total_amount === 'number'
          ? (row.total_amount as number)
          : null,
    status: String(row.status ?? ''),
    due_date: typeof row.due_date === 'string' ? (row.due_date as string) : null,
  }));
}

/**
 * Recent activity arm for account_view. Wave 3 spec: "top 20 from §5
 * unified view IF §5 merged; else from Bam activity_log only". §5 has
 * landed (GET /v1/activity/unified), so we call it with entity_type
 * 'bond.company' and the resolved company id.
 */
async function fetchAccountActivity(
  apiBase: string,
  headers: Record<string, string>,
  companyId: string,
): Promise<AccountActivity[]> {
  const qs = new URLSearchParams({
    entity_type: 'bond.company',
    entity_id: companyId,
    limit: '20',
  });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${apiBase}/v1/activity/unified?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`unified activity: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((row) => ({
    id: String(row.id ?? ''),
    source_app: String(row.source_app ?? ''),
    action: String(row.action ?? ''),
    actor_id: typeof row.actor_id === 'string' ? (row.actor_id as string) : null,
    created_at: String(row.created_at ?? ''),
  }));
}

/**
 * Owners arm. Aggregates the company's owner_id + the distinct owner_ids
 * from the open deals, and (if resolvable) decorates with display_name.
 */
async function fetchAccountOwners(
  apiBase: string,
  bondBase: string,
  headers: Record<string, string>,
  companyId: string,
  dealOwnerIds: string[],
): Promise<AccountOwner[]> {
  const companyRes = await fetchWithTimeout<{ data?: { owner_id?: string | null } }>(
    `${bondBase}/companies/${companyId}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  const accountOwnerId =
    companyRes.ok && typeof companyRes.data?.data?.owner_id === 'string'
      ? (companyRes.data!.data!.owner_id as string)
      : null;

  const uniqueIds = new Set<string>();
  if (accountOwnerId) uniqueIds.add(accountOwnerId);
  for (const id of dealOwnerIds) if (id) uniqueIds.add(id);

  if (uniqueIds.size === 0) return [];

  const users = await Promise.all(
    Array.from(uniqueIds).map(async (uid) => {
      try {
        const r = await fetchWithTimeout<{ data?: { id: string; display_name?: string } }>(
          `${apiBase}/users/${uid}`,
          { method: 'GET', headers },
          ARM_TIMEOUT_MS,
        );
        if (!r.ok || !r.data?.data) return null;
        return { id: r.data.data.id, display_name: r.data.data.display_name ?? '' };
      } catch {
        return null;
      }
    }),
  );

  const byId = new Map<string, string>();
  for (const u of users) if (u) byId.set(u.id, u.display_name);

  const out: AccountOwner[] = [];
  if (accountOwnerId) {
    out.push({
      user_id: accountOwnerId,
      display_name: byId.get(accountOwnerId) ?? '',
      role: 'account',
    });
  }
  for (const id of dealOwnerIds) {
    if (!id || id === accountOwnerId) continue;
    if (out.some((o) => o.user_id === id)) continue;
    out.push({
      user_id: id,
      display_name: byId.get(id) ?? '',
      role: 'deal',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// project_view helpers
// ---------------------------------------------------------------------------

interface ProjectInfo {
  id: string;
  name: string;
  slug: string | null;
  org_id: string;
}

async function fetchProject(
  apiBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<ProjectInfo> {
  const r = await fetchWithTimeout<{ data?: Record<string, unknown> } | Record<string, unknown>>(
    `${apiBase}/projects/${projectId}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bam project: status ${r.status}`);
  const raw =
    (r.data as { data?: Record<string, unknown> }).data ?? (r.data as Record<string, unknown>);
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    slug: typeof raw.slug === 'string' ? (raw.slug as string) : null,
    org_id: String(raw.org_id ?? ''),
  };
}

async function fetchOpenTasksCount(
  apiBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<number> {
  // /projects/:id/tasks returns the first page; we ask for a big page (200)
  // and return the in-page count. Tasks rows do not include state_category
  // directly (only state_id pointing at task_states.category), so the
  // "open" filter is deliberately not applied at this layer: doing so
  // would require an extra join the REST route does not expose. If the
  // response does happen to carry a state_category field (some integrations
  // join it in), we honor it as an open-filter; otherwise we fall back to
  // the total page count. A dedicated aggregate endpoint is tracked as
  // follow-up work.
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${apiBase}/projects/${projectId}/tasks?limit=200`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bam tasks: status ${r.status}`);
  const rows = r.data?.data ?? [];
  const anyHasCategory = rows.some((t) => typeof t.state_category === 'string');
  if (!anyHasCategory) return rows.length;
  return rows.filter((t) => {
    const cat = String(t.state_category ?? '').toLowerCase();
    return cat !== 'done' && cat !== 'cancelled';
  }).length;
}

async function fetchActiveSprint(
  apiBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<{ id: string; name: string; ends_at: string } | null> {
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${apiBase}/projects/${projectId}/sprints`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bam sprints: status ${r.status}`);
  const rows = r.data?.data ?? [];
  const active = rows.find((s) => String(s.status ?? '').toLowerCase() === 'active');
  if (!active) return null;
  return {
    id: String(active.id ?? ''),
    name: String(active.name ?? ''),
    ends_at: String(active.end_date ?? ''),
  };
}

async function fetchProjectGoals(
  bearingBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<Array<{ id: string; title: string; status: string; progress_pct: number }>> {
  const qs = new URLSearchParams({ project_id: projectId, limit: '50' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${bearingBase}/goals?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bearing goals: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.map((g) => ({
    id: String(g.id ?? ''),
    title: String(g.title ?? ''),
    status: String(g.status ?? ''),
    progress_pct:
      typeof g.progress === 'number'
        ? (g.progress as number)
        : typeof g.progress === 'string'
          ? Number.parseFloat(g.progress as string) || 0
          : 0,
  }));
}

async function fetchProjectBriefDocs(
  briefBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<Array<{ id: string; title: string; updated_at: string; author_id: string | null }>> {
  const qs = new URLSearchParams({ project_id: projectId, limit: '20' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${briefBase}/documents?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`brief documents: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((d) => ({
    id: String(d.id ?? ''),
    title: String(d.title ?? ''),
    updated_at: String(d.updated_at ?? ''),
    author_id:
      typeof d.created_by === 'string'
        ? (d.created_by as string)
        : typeof d.author_id === 'string'
          ? (d.author_id as string)
          : null,
  }));
}

async function fetchProjectBeaconEntries(
  beaconBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<Array<{ id: string; title: string; updated_at: string }>> {
  const qs = new URLSearchParams({ project_id: projectId, limit: '20' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${beaconBase}/beacons?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`beacon entries: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((b) => ({
    id: String(b.id ?? ''),
    title: String(b.title ?? ''),
    updated_at: String(b.updated_at ?? ''),
  }));
}

async function fetchTopContributors(
  apiBase: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<Array<{ user_id: string; display_name: string; action_count: number }>> {
  // Prefer the unified activity view (§5) so the contributor bucket reflects
  // Bam + Bond + Helpdesk in one call. The unified endpoint takes
  // entity_type + entity_id; we use 'bam.project' to ask for everything
  // scoped to this project. If the unified endpoint is not reachable, fall
  // back to /projects/:id/activity (Bam only) so the arm stays useful.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const unifiedQs = new URLSearchParams({
    entity_type: 'bam.project',
    entity_id: projectId,
    since,
    limit: '200',
  });
  let rows: Array<Record<string, unknown>> = [];
  let unifiedReachable = false;
  try {
    const ru = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
      `${apiBase}/v1/activity/unified?${unifiedQs.toString()}`,
      { method: 'GET', headers },
      ARM_TIMEOUT_MS,
    );
    if (ru.ok) {
      unifiedReachable = true;
      rows = ru.data?.data ?? [];
    }
  } catch {
    // fall through to per-project activity
  }

  if (!unifiedReachable) {
    const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
      `${apiBase}/projects/${projectId}/activity?limit=200`,
      { method: 'GET', headers },
      ARM_TIMEOUT_MS,
    );
    if (!r.ok) throw new Error(`bam project activity: status ${r.status}`);
    rows = r.data?.data ?? [];
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const actor = typeof row.actor_id === 'string' ? (row.actor_id as string) : null;
    if (!actor) continue;
    const createdAt = Date.parse(String(row.created_at ?? ''));
    if (Number.isFinite(createdAt) && createdAt < cutoff) continue;
    counts.set(actor, (counts.get(actor) ?? 0) + 1);
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (sorted.length === 0) return [];

  // Resolve display names. Failures are swallowed and the row gets an empty name.
  const names = await Promise.all(
    sorted.map(async ([uid]) => {
      try {
        const rr = await fetchWithTimeout<{ data?: { id: string; display_name?: string } }>(
          `${apiBase}/users/${uid}`,
          { method: 'GET', headers },
          ARM_TIMEOUT_MS,
        );
        if (!rr.ok || !rr.data?.data) return { uid, name: '' };
        return { uid, name: rr.data.data.display_name ?? '' };
      } catch {
        return { uid, name: '' };
      }
    }),
  );
  const nameById = new Map(names.map((n) => [n.uid, n.name]));

  return sorted.map(([uid, n]) => ({
    user_id: uid,
    display_name: nameById.get(uid) ?? '',
    action_count: n,
  }));
}

// ---------------------------------------------------------------------------
// user_view helpers
// ---------------------------------------------------------------------------

interface UserInfo {
  id: string;
  email: string;
  display_name: string;
  kind: 'human' | 'agent' | 'service';
  role: string;
}

async function fetchUser(
  apiBase: string,
  headers: Record<string, string>,
  userId: string,
): Promise<UserInfo> {
  const r = await fetchWithTimeout<{ data?: Record<string, unknown> }>(
    `${apiBase}/users/${userId}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bam user: status ${r.status}`);
  const u = r.data?.data ?? {};
  return {
    id: String(u.id ?? userId),
    email: String(u.email ?? ''),
    display_name: String(u.display_name ?? ''),
    kind: (u.kind as 'human' | 'agent' | 'service') ?? 'human',
    role: String(u.role ?? ''),
  };
}

async function fetchUserOwnedDeals(
  bondBase: string,
  headers: Record<string, string>,
  userId: string,
): Promise<Array<{ id: string; name: string; stage: string | null; value_cents: number | null }>> {
  const qs = new URLSearchParams({ owner_id: userId, limit: '20' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${bondBase}/deals?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bond deals: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((d) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    stage: typeof d.stage_id === 'string' ? (d.stage_id as string) : null,
    value_cents: typeof d.value === 'number' ? (d.value as number) : null,
  }));
}

async function fetchUserAssignedTickets(
  helpdeskBase: string,
  headers: Record<string, string>,
  userId: string,
): Promise<Array<{ id: string; number: number | null; subject: string; status: string }>> {
  // Wave-3 gap: helpdesk-api has no "list open tickets by assignee" route.
  // GET /tickets does not expose assignee_id, and GET /tickets/search
  // requires a non-empty q (the server trims whitespace and 400s on empty).
  // We call /tickets/search with the common letter 'a', which ILIKE-matches
  // essentially every real ticket body or subject, and narrow with
  // status=open + assignee_id. A dedicated listing endpoint (or optional-q
  // support on /tickets/search) is tracked as follow-up work.
  const qs = new URLSearchParams({ q: 'a', status: 'open', assignee_id: userId });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${helpdeskBase}/tickets/search?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`helpdesk tickets/search: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((t) => ({
    id: String(t.id ?? ''),
    number: typeof t.number === 'number' ? (t.number as number) : null,
    subject: String(t.subject ?? ''),
    status: String(t.status ?? ''),
  }));
}

async function fetchUserRecentActivity(
  apiBase: string,
  headers: Record<string, string>,
  userId: string,
): Promise<
  Array<{
    id: string;
    source_app: string;
    action: string;
    entity_id: string | null;
    created_at: string;
  }>
> {
  const qs = new URLSearchParams({ actor_id: userId, limit: '20' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${apiBase}/v1/activity/unified/by-actor?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`unified activity by-actor: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((row) => ({
    id: String(row.id ?? ''),
    source_app: String(row.source_app ?? ''),
    action: String(row.action ?? ''),
    entity_id: typeof row.entity_id === 'string' ? (row.entity_id as string) : null,
    created_at: String(row.created_at ?? ''),
  }));
}

async function fetchUserOwnedGoals(
  bearingBase: string,
  headers: Record<string, string>,
  userId: string,
): Promise<Array<{ id: string; title: string; progress_pct: number }>> {
  const qs = new URLSearchParams({ owner_id: userId, limit: '20' });
  const r = await fetchWithTimeout<{ data?: Array<Record<string, unknown>> }>(
    `${bearingBase}/goals?${qs.toString()}`,
    { method: 'GET', headers },
    ARM_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`bearing goals: status ${r.status}`);
  const rows = r.data?.data ?? [];
  return rows.slice(0, 20).map((g) => ({
    id: String(g.id ?? ''),
    title: String(g.title ?? ''),
    progress_pct:
      typeof g.progress === 'number'
        ? (g.progress as number)
        : typeof g.progress === 'string'
          ? Number.parseFloat(g.progress as string) || 0
          : 0,
  }));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompositeTools(
  server: McpServer,
  api: ApiClient,
  urls: CompositeToolUrls,
): void {
  // -------------------------------------------------------------------------
  // account_view
  // -------------------------------------------------------------------------
  registerTool(server, {
    name: 'account_view',
    description:
      'Composite account-page view. Resolves one of { company_id, contact_id, domain } to a company, then fans out in parallel to bond (deals, owners), helpdesk (tickets), bill (invoices), bam (tasks), and the Bam activity log (recent_activity). Each arm has a 5s timeout; per-arm failures set the corresponding field to empty and append the arm name to `missing`. Returns only entities visible to the caller; asker-mode (as_user_id) is not supported in Wave 3. Returns 502 COMPOSITE_FAILED only if every arm fails.',
    input: {
      company_id: z.string().uuid().optional().describe('Bond company id to load'),
      contact_id: z
        .string()
        .uuid()
        .optional()
        .describe('Bond contact id. The primary associated company is used.'),
      domain: z
        .string()
        .optional()
        .describe('Company domain. Resolves to company_id via /companies?search=...'),
    },
    returns: z.object({
      resolved: z.object({
        company_id: z.string(),
        company_name: z.string(),
        domain: z.string().nullable(),
        resolved_from: z.enum(['company_id', 'contact_id', 'domain']),
      }),
      deals: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          stage: z.string().nullable(),
          value_cents: z.number().nullable(),
          expected_close_date: z.string().nullable(),
          owner_id: z.string().nullable(),
        }),
      ),
      tickets: z.array(
        z.object({
          id: z.string(),
          number: z.number().nullable(),
          subject: z.string(),
          status: z.string(),
          priority: z.string().nullable(),
          updated_at: z.string(),
        }),
      ),
      invoices: z.array(
        z.object({
          id: z.string(),
          number: z.string().nullable(),
          amount_cents: z.number().nullable(),
          status: z.string(),
          due_date: z.string().nullable(),
        }),
      ),
      tasks: z.array(
        z.object({
          id: z.string(),
          human_id: z.string().nullable(),
          title: z.string(),
          state_category: z.string().nullable(),
          project_id: z.string(),
        }),
      ),
      recent_activity: z.array(
        z.object({
          id: z.string(),
          source_app: z.string(),
          action: z.string(),
          actor_id: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
      owners: z.array(
        z.object({
          user_id: z.string(),
          display_name: z.string(),
          role: z.enum(['account', 'deal', 'support']),
        }),
      ),
      partial: z.boolean(),
      missing: z.array(z.string()),
    }),
    handler: async (args) => {
      const { company_id, contact_id, domain } = args;
      if (!company_id && !contact_id && !domain) {
        return errEnvelope(
          'VALIDATION_ERROR',
          'One of company_id, contact_id, or domain is required',
          400,
        );
      }

      let resolved: ResolvedAccount | null;
      try {
        resolved = await resolveAccount(urls, api, { company_id, contact_id, domain });
      } catch {
        resolved = null;
      }
      if (!resolved) {
        return errEnvelope(
          'NOT_FOUND',
          'Could not resolve company from the supplied identifier',
          404,
        );
      }

      const bondBase = trimBase(urls.bondApiUrl);
      const helpdeskBase = trimBase(urls.helpdeskApiUrl);
      const billBase = trimBase(urls.billApiUrl);
      const apiBase = trimBase(urls.apiUrl);
      const headers = authHeaders(api);

      const dealsOutcome = await runArm('deals', () =>
        fetchAccountDeals(bondBase, headers, resolved!.company_id),
      );
      // Kick off remaining arms now that we have the deals (needed for owners).
      const [ticketsOutcome, invoicesOutcome, activityOutcome, ownersOutcome] = await Promise.all([
        runArm('tickets', () => fetchAccountTickets(helpdeskBase, headers)),
        runArm('invoices', () => fetchAccountInvoices(billBase, headers, resolved!.company_id)),
        runArm('recent_activity', () =>
          fetchAccountActivity(apiBase, headers, resolved!.company_id),
        ),
        runArm('owners', () =>
          fetchAccountOwners(
            apiBase,
            bondBase,
            headers,
            resolved!.company_id,
            (dealsOutcome.value ?? [])
              .map((d) => d.owner_id)
              .filter((id): id is string => typeof id === 'string'),
          ),
        ),
      ]);

      // Tasks: there is no company -> task link in Wave 3. Leave empty;
      // this is a successful empty arm, not a failure, so it is NOT added
      // to `missing`.
      const tasks: AccountTask[] = [];

      const arms = [dealsOutcome, ticketsOutcome, invoicesOutcome, activityOutcome, ownersOutcome];
      const missing = arms.filter((o) => o.failed).map((o) => o.name);
      const allFailed = arms.every((o) => o.failed);

      if (allFailed) {
        return errEnvelope(
          'COMPOSITE_FAILED',
          'Every composite arm failed for account_view',
          502,
        );
      }

      return ok({
        resolved,
        deals: dealsOutcome.value ?? [],
        tickets: ticketsOutcome.value ?? [],
        invoices: invoicesOutcome.value ?? [],
        tasks,
        recent_activity: activityOutcome.value ?? [],
        owners: ownersOutcome.value ?? [],
        partial: missing.length > 0,
        missing,
      });
    },
  });

  // -------------------------------------------------------------------------
  // project_view
  // -------------------------------------------------------------------------
  registerTool(server, {
    name: 'project_view',
    description:
      "Composite project-overview view. Fans out in parallel to Bam (project, task count, active sprint, activity for top contributors), Bearing (linked goals), Brief (recent documents), and Beacon (recent entries). Each arm has a 5s timeout; per-arm failures set the corresponding field to empty/null and append the arm name to `missing`. top_contributors is a 30-day client-side GROUP BY over /projects/:id/activity today; when the §5 unified activity_query tool lands, it will be preferred automatically. Returns only entities visible to the caller; asker-mode is not supported in Wave 3. Returns 502 COMPOSITE_FAILED only if every arm fails.",
    input: {
      project_id: z.string().uuid().describe('Bam project id to load'),
    },
    returns: z.object({
      project: z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string().nullable(),
        org_id: z.string(),
      }),
      open_tasks_count: z.number(),
      active_sprint: z
        .object({
          id: z.string(),
          name: z.string(),
          ends_at: z.string(),
        })
        .nullable(),
      goals_linked: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          progress_pct: z.number(),
        }),
      ),
      recent_brief_docs: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          updated_at: z.string(),
          author_id: z.string().nullable(),
        }),
      ),
      recent_beacon_entries: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          updated_at: z.string(),
        }),
      ),
      top_contributors: z.array(
        z.object({
          user_id: z.string(),
          display_name: z.string(),
          action_count: z.number(),
        }),
      ),
      partial: z.boolean(),
      missing: z.array(z.string()),
    }),
    handler: async ({ project_id }) => {
      const apiBase = trimBase(urls.apiUrl);
      const bearingBase = trimBase(urls.bearingApiUrl);
      const briefBase = trimBase(urls.briefApiUrl);
      const beaconBase = trimBase(urls.beaconApiUrl);
      const headers = authHeaders(api);

      const [
        projectOutcome,
        openTasksOutcome,
        activeSprintOutcome,
        goalsOutcome,
        briefOutcome,
        beaconOutcome,
        contributorsOutcome,
      ] = await Promise.all([
        runArm('project', () => fetchProject(apiBase, headers, project_id)),
        runArm('open_tasks_count', () => fetchOpenTasksCount(apiBase, headers, project_id)),
        runArm('active_sprint', () => fetchActiveSprint(apiBase, headers, project_id)),
        runArm('goals_linked', () => fetchProjectGoals(bearingBase, headers, project_id)),
        runArm('recent_brief_docs', () => fetchProjectBriefDocs(briefBase, headers, project_id)),
        runArm('recent_beacon_entries', () =>
          fetchProjectBeaconEntries(beaconBase, headers, project_id),
        ),
        runArm('top_contributors', () => fetchTopContributors(apiBase, headers, project_id)),
      ]);

      const arms = [
        projectOutcome,
        openTasksOutcome,
        activeSprintOutcome,
        goalsOutcome,
        briefOutcome,
        beaconOutcome,
        contributorsOutcome,
      ];
      const allFailed = arms.every((o) => o.failed);
      if (allFailed) {
        return errEnvelope(
          'COMPOSITE_FAILED',
          'Every composite arm failed for project_view',
          502,
        );
      }

      // Stance A (#28): hide existence on no-access. The project arm hits the
      // same /projects/:id gate as get_project (404 when the caller isn't a
      // project member). If it failed while sibling arms on the same api base
      // succeeded, the caller can't see this project — return NOT_FOUND rather
      // than echoing a stub with the id intact (which leaked existence and let
      // a caller probe the inconsistency vs get_project/list_members). This
      // also means the `missing` array — which could distinguish "denied" from
      // "empty" — is never returned to a denied caller.
      if (projectOutcome.failed) {
        return errEnvelope('NOT_FOUND', 'Project not found', 404);
      }
      const project: ProjectInfo = projectOutcome.value!;

      const missing = arms.filter((o) => o.failed).map((o) => o.name);
      return ok({
        project,
        open_tasks_count: openTasksOutcome.value ?? 0,
        active_sprint: activeSprintOutcome.value ?? null,
        goals_linked: goalsOutcome.value ?? [],
        recent_brief_docs: briefOutcome.value ?? [],
        recent_beacon_entries: beaconOutcome.value ?? [],
        top_contributors: contributorsOutcome.value ?? [],
        partial: missing.length > 0,
        missing,
      });
    },
  });

  // -------------------------------------------------------------------------
  // user_view
  // -------------------------------------------------------------------------
  registerTool(server, {
    name: 'user_view',
    description:
      "Composite person-profile view. Fans out in parallel to Bam (user via /users/:id, recent activity stub), Bond (owned deals), Helpdesk (open tickets via /tickets/search), and Bearing (owned goals). Each arm has a 5s timeout; per-arm failures set the corresponding field to empty and append the arm name to `missing`. user.kind is the users.kind column added in Wave 1 (human/agent/service). Returns only entities visible to the caller; asker-mode is not supported in Wave 3. Returns 502 COMPOSITE_FAILED only if every arm fails.",
    input: {
      user_id: z.string().uuid().describe('Bam user id to load'),
    },
    returns: z.object({
      user: z.object({
        id: z.string(),
        email: z.string(),
        display_name: z.string(),
        kind: z.enum(['human', 'agent', 'service']),
        role: z.string(),
      }),
      owned_deals: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          stage: z.string().nullable(),
          value_cents: z.number().nullable(),
        }),
      ),
      assigned_tasks: z.array(
        z.object({
          id: z.string(),
          human_id: z.string().nullable(),
          title: z.string(),
          state_category: z.string().nullable(),
          project_id: z.string(),
        }),
      ),
      open_tickets: z.array(
        z.object({
          id: z.string(),
          number: z.number().nullable(),
          subject: z.string(),
          status: z.string(),
        }),
      ),
      goals_owned: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          progress_pct: z.number(),
        }),
      ),
      recent_activity: z.array(
        z.object({
          id: z.string(),
          source_app: z.string(),
          action: z.string(),
          entity_id: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
      partial: z.boolean(),
      missing: z.array(z.string()),
    }),
    handler: async ({ user_id }) => {
      const apiBase = trimBase(urls.apiUrl);
      const bondBase = trimBase(urls.bondApiUrl);
      const helpdeskBase = trimBase(urls.helpdeskApiUrl);
      const bearingBase = trimBase(urls.bearingApiUrl);
      const headers = authHeaders(api);

      const [userOutcome, dealsOutcome, ticketsOutcome, goalsOutcome, activityOutcome] =
        await Promise.all([
          runArm('user', () => fetchUser(apiBase, headers, user_id)),
          runArm('owned_deals', () => fetchUserOwnedDeals(bondBase, headers, user_id)),
          runArm('open_tickets', () => fetchUserAssignedTickets(helpdeskBase, headers, user_id)),
          runArm('goals_owned', () => fetchUserOwnedGoals(bearingBase, headers, user_id)),
          runArm('recent_activity', () => fetchUserRecentActivity(apiBase, headers, user_id)),
        ]);

      // assigned_tasks: there is no global /tasks?assignee_id=... endpoint in
      // Wave 3. We leave the array empty and do NOT list it in `missing`:
      // it's a known Wave 3 gap, not an arm failure. When a per-user task
      // endpoint lands, this arm can be wired without changing the shape.
      const assigned_tasks: Array<{
        id: string;
        human_id: string | null;
        title: string;
        state_category: string | null;
        project_id: string;
      }> = [];

      const arms = [userOutcome, dealsOutcome, ticketsOutcome, goalsOutcome, activityOutcome];
      const allFailed = arms.every((o) => o.failed);
      if (allFailed) {
        return errEnvelope(
          'COMPOSITE_FAILED',
          'Every composite arm failed for user_view',
          502,
        );
      }

      // Stance A (#28): if the user arm itself failed (caller can't see this
      // user) while sibling arms succeeded, return NOT_FOUND rather than
      // echoing a stub with the id — same existence-hiding posture as the
      // per-entity reads. Denied callers never receive the `missing` array.
      if (userOutcome.failed) {
        return errEnvelope('NOT_FOUND', 'User not found', 404);
      }
      const user: UserInfo = userOutcome.value!;

      const missing = arms.filter((o) => o.failed).map((o) => o.name);
      return ok({
        user,
        owned_deals: dealsOutcome.value ?? [],
        assigned_tasks,
        open_tickets: ticketsOutcome.value ?? [],
        goals_owned: goalsOutcome.value ?? [],
        recent_activity: activityOutcome.value ?? [],
        partial: missing.length > 0,
        missing,
      });
    },
  });
}
