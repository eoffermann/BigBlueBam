import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/common/button';
import { Dialog } from '@/components/common/dialog';
import {
  listMyAdminOrgs,
  listOrgProjects,
  inviteBulkToOrg,
  type AdminOrg,
  type BulkInviteResult,
} from '@/lib/api/people-manager';

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedInvitee {
  email: string;
  name?: string;
}

interface ParseOutcome {
  invitees: ParsedInvitee[];
  invalid: string[];
}

/**
 * Parse a freeform textarea of invitees. Accepts newline- and/or
 * comma-separated entries, each optionally in `Name <email>` form. Dedups by
 * lowercased email and collects entries that don't contain a valid-looking
 * email so the operator can fix them.
 */
export function parseInvitees(raw: string): ParseOutcome {
  const invitees: ParsedInvitee[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  // Split on newlines and commas, but keep `Name <email>` intact (the `<>`
  // wrapping the email means a comma inside a display name is rare; we split
  // on commas too, which is the common "a@x.com, b@y.com" paste shape).
  const tokens = raw
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    let name: string | undefined;
    let email = token;

    const angled = token.match(/^(.*?)<([^>]+)>$/);
    if (angled) {
      const rawName = (angled[1] ?? '').trim().replace(/^["']|["']$/g, '');
      name = rawName || undefined;
      email = (angled[2] ?? '').trim();
    }

    // Minimal email shape check — the backend re-validates with Zod.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalid.push(token);
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    invitees.push({ email, name });
  }

  return { invitees, invalid };
}

type OrgRole = 'member' | 'admin';

interface OrgSelection {
  role: OrgRole;
  projectIds: Set<string>;
}

/** Per-invitee × per-org outcome flattened for the result panel. */
interface ResultRow {
  orgName: string;
  email: string;
  status: 'created' | 'existing' | 'failed';
  emailSent?: boolean;
  projectsAdded?: number;
  projectsSkipped?: number;
  reason?: string;
}

/** Lazy project picker for one selected org. */
function OrgProjectPicker({
  org,
  selection,
  onToggleProject,
  onRoleChange,
}: {
  org: AdminOrg;
  selection: OrgSelection;
  onToggleProject: (orgId: string, projectId: string) => void;
  onRoleChange: (orgId: string, role: OrgRole) => void;
}) {
  const { data: projects, isLoading } = useQuery({
    queryKey: ['people-manager', 'org-projects', org.org_id],
    queryFn: () => listOrgProjects(org.org_id),
  });

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {org.name}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-zinc-500">
          Invite role
          <select
            value={selection.role}
            onChange={(e) => onRoleChange(org.org_id, e.target.value as OrgRole)}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>

      <div>
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
          Add to projects (optional)
        </p>
        {isLoading ? (
          <p className="text-xs text-zinc-400">Loading projects…</p>
        ) : !projects || projects.length === 0 ? (
          <p className="text-xs text-zinc-500">No projects in this org.</p>
        ) : (
          <div className="max-h-32 overflow-y-auto rounded-md border border-zinc-100 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
            {projects.map((p) => {
              const checked = selection.projectIds.has(p.id);
              return (
                <label
                  key={p.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleProject(org.org_id, p.id)}
                    className="rounded text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-zinc-900 dark:text-zinc-100 truncate">{p.name}</span>
                  <span className="text-xs font-mono text-zinc-400">{p.task_id_prefix}</span>
                </label>
              );
            })}
          </div>
        )}
        <p className="mt-1 text-[11px] text-zinc-400">
          Invitees are added as project <strong>member</strong>; adjust roles later.
        </p>
      </div>
    </div>
  );
}

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const queryClient = useQueryClient();

  const [rawInvitees, setRawInvitees] = useState('');
  // org_id -> selection (presence in the map == selected org)
  const [orgSelections, setOrgSelections] = useState<Map<string, OrgSelection>>(new Map());

  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<ResultRow[] | null>(null);

  const { data: adminOrgs, isLoading: orgsLoading } = useQuery({
    queryKey: ['people-manager', 'admin-orgs'],
    queryFn: listMyAdminOrgs,
    enabled: open,
  });

  const parsed = useMemo(() => parseInvitees(rawInvitees), [rawInvitees]);

  const selectedOrgIds = useMemo(() => Array.from(orgSelections.keys()), [orgSelections]);

  const toggleOrg = (orgId: string) => {
    setOrgSelections((prev) => {
      const next = new Map(prev);
      if (next.has(orgId)) next.delete(orgId);
      else next.set(orgId, { role: 'member', projectIds: new Set() });
      return next;
    });
  };

  const setOrgRole = (orgId: string, role: OrgRole) => {
    setOrgSelections((prev) => {
      const next = new Map(prev);
      const cur = next.get(orgId);
      if (cur) next.set(orgId, { ...cur, role });
      return next;
    });
  };

  const toggleProject = (orgId: string, projectId: string) => {
    setOrgSelections((prev) => {
      const next = new Map(prev);
      const cur = next.get(orgId);
      if (!cur) return prev;
      const projectIds = new Set(cur.projectIds);
      if (projectIds.has(projectId)) projectIds.delete(projectId);
      else projectIds.add(projectId);
      next.set(orgId, { ...cur, projectIds });
      return next;
    });
  };

  function resetForm() {
    setRawInvitees('');
    setOrgSelections(new Map());
    setResults(null);
    setSubmitting(false);
  }

  function close() {
    onOpenChange(false);
    window.setTimeout(resetForm, 200);
  }

  const canSubmit =
    parsed.invitees.length > 0 && selectedOrgIds.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !adminOrgs) return;
    setSubmitting(true);
    const rows: ResultRow[] = [];

    // Fan out one bulk-invite call PER selected org, with X-Org-Id set to that
    // org and only that org's selected project ids. Failures are per-org, not
    // all-or-nothing.
    for (const orgId of selectedOrgIds) {
      const org = adminOrgs.find((o) => o.org_id === orgId);
      const sel = orgSelections.get(orgId);
      if (!org || !sel) continue;
      const orgName = org.name;
      const invites = parsed.invitees.map((p) => ({
        email: p.email,
        ...(p.name ? { display_name: p.name } : {}),
        role: sel.role,
      }));
      try {
        const res: BulkInviteResult = await inviteBulkToOrg(orgId, {
          invites,
          default_project_ids: Array.from(sel.projectIds),
        });
        for (const s of res.succeeded) {
          rows.push({
            orgName,
            email: s.email,
            status: s.was_existing ? 'existing' : 'created',
            emailSent: s.email_sent,
            projectsAdded: s.projects_added.length,
            projectsSkipped: s.projects_skipped.length,
          });
        }
        for (const f of res.failed) {
          rows.push({ orgName, email: f.email, status: 'failed', reason: f.message });
        }
      } catch (err) {
        // Whole-org failure (e.g. 403 not-admin, network). Mark every invitee
        // for that org as failed so the panel is complete.
        const reason = (err as Error)?.message ?? 'Request failed';
        for (const p of parsed.invitees) {
          rows.push({ orgName, email: p.email, status: 'failed', reason });
        }
      }
    }

    setResults(rows);
    setSubmitting(false);
    queryClient.invalidateQueries({ queryKey: ['people-manager'] });
    queryClient.invalidateQueries({ queryKey: ['people'] });
  }

  const successCount = results?.filter((r) => r.status !== 'failed').length ?? 0;
  const failCount = results?.filter((r) => r.status === 'failed').length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={results ? 'Invite results' : 'Invite people'}
      description={
        results
          ? `${successCount} invite${successCount === 1 ? '' : 's'} processed${
              failCount > 0 ? `, ${failCount} failed` : ''
            }`
          : 'Invite many people at once into one or more organizations you administer.'
      }
      className="max-w-2xl"
    >
      {results ? (
        <div className="space-y-4">
          <div className="max-h-80 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800/80 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Email</th>
                  <th className="px-3 py-1.5 font-medium">Org</th>
                  <th className="px-3 py-1.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {results.map((r, idx) => (
                  <tr key={`${r.email}-${r.orgName}-${idx}`}>
                    <td className="px-3 py-1.5 text-zinc-800 dark:text-zinc-200 truncate">
                      {r.email}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500 truncate">{r.orgName}</td>
                    <td className="px-3 py-1.5">
                      {r.status === 'failed' ? (
                        <span className="text-red-600 dark:text-red-400">
                          Failed{r.reason ? `: ${r.reason}` : ''}
                        </span>
                      ) : (
                        <span className="text-green-700 dark:text-green-300">
                          {r.status === 'existing' ? 'Added (existing user)' : 'Created'}
                          {r.emailSent ? ' · email sent' : ' · no email (share manually)'}
                          {typeof r.projectsAdded === 'number' && r.projectsAdded > 0
                            ? ` · ${r.projectsAdded} project${r.projectsAdded === 1 ? '' : 's'}`
                            : ''}
                          {typeof r.projectsSkipped === 'number' && r.projectsSkipped > 0
                            ? ` · ${r.projectsSkipped} skipped`
                            : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={resetForm}>
              Invite more
            </Button>
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Invitees */}
          <div>
            <label
              htmlFor="pm-invite-invitees"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
            >
              Invitees
            </label>
            <textarea
              id="pm-invite-invitees"
              value={rawInvitees}
              onChange={(e) => setRawInvitees(e.target.value)}
              rows={4}
              placeholder={'jane@acme.com, bob@acme.com\nJane Doe <jane@acme.com>'}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="mt-1 text-xs text-zinc-500">
              One per line or comma-separated. Optional <code>Name &lt;email&gt;</code> form.
              {parsed.invitees.length > 0 && (
                <span className="text-zinc-700 dark:text-zinc-300">
                  {' '}
                  {parsed.invitees.length} valid
                </span>
              )}
              {parsed.invalid.length > 0 && (
                <span className="text-red-600 dark:text-red-400">
                  {' '}
                  · {parsed.invalid.length} invalid ({parsed.invalid.slice(0, 3).join(', ')}
                  {parsed.invalid.length > 3 ? '…' : ''})
                </span>
              )}
            </p>
          </div>

          {/* Org selection */}
          <div>
            <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Organizations
            </span>
            {orgsLoading ? (
              <p className="text-xs text-zinc-400">Loading your organizations…</p>
            ) : !adminOrgs || adminOrgs.length === 0 ? (
              <p className="text-xs text-zinc-500">
                You don't administer any organizations, so you can't invite. Ask an
                admin/owner of an org to grant you access.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {adminOrgs.map((o) => {
                  const selected = orgSelections.has(o.org_id);
                  return (
                    <button
                      key={o.org_id}
                      type="button"
                      onClick={() => toggleOrg(o.org_id)}
                      className={
                        selected
                          ? 'inline-flex items-center gap-1.5 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-sm text-primary-700 dark:border-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                          : 'inline-flex items-center gap-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 px-3 py-1 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                      }
                    >
                      {o.name}
                      <span className="text-xs text-zinc-400 capitalize">{o.role}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Per-selected-org role + projects */}
          {selectedOrgIds.length > 0 && adminOrgs && (
            <div className="space-y-2">
              {selectedOrgIds.map((orgId) => {
                const org = adminOrgs.find((o) => o.org_id === orgId);
                const sel = orgSelections.get(orgId);
                if (!org || !sel) return null;
                return (
                  <OrgProjectPicker
                    key={orgId}
                    org={org}
                    selection={sel}
                    onToggleProject={toggleProject}
                    onRoleChange={setOrgRole}
                  />
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} loading={submitting} disabled={!canSubmit}>
              {parsed.invitees.length > 0 && selectedOrgIds.length > 0
                ? `Invite ${parsed.invitees.length} to ${selectedOrgIds.length} org${
                    selectedOrgIds.length === 1 ? '' : 's'
                  }`
                : 'Invite'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
