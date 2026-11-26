import { useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { BastionCompanyProfile, BastionTemplateKey } from '@bigbluebam/shared';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import { useCan } from '@bigbluebam/ui/use-can';
import { ApiError, type AssertionRow, type FrameworkView, type PopulationView, type SetupState } from '@/lib/api';
import { friendlyError, technicalDetails } from '@/lib/errors';
import {
  useAdoptFramework,
  useBamProjects,
  useCompileFramework,
  useConfirmAssertion,
  useCreateComplianceProject,
  useDecideApplicability,
  useRejectAssertion,
  useRequirements,
  useRevisePopulation,
  useSaveProfile,
  useSetComplianceProject,
  useSetup,
  useTemplates,
} from '@/hooks/use-bastion';

// The Setup wizard (spec 6.1 /bastion/setup): frameworks, company profile, the required
// Compliance project, proposed checks with "This is the complete list", and ISO applicability.
//
// Actions are hidden when the person lacks the permission behind them (spec 6.3, issue #194):
// framework.write (adopt, profile, Compliance project), framework.compile (set up checks),
// assertion.confirm (confirm, reject), assertion.propose (add or remove list members) and
// control.write (ISO applicability). Errors use plain sentences (lib/errors.ts).

const errorText = friendlyError;

/** What each setup permission lets a person do here. */
export interface SetupPermissions {
  frameworkWrite: boolean;
  compile: boolean;
  confirm: boolean;
  propose: boolean;
  controlWrite: boolean;
}

function useSetupPermissions(): SetupPermissions {
  return {
    frameworkWrite: useCan('bastion.framework.write'),
    compile: useCan('bastion.framework.compile'),
    confirm: useCan('bastion.assertion.confirm'),
    propose: useCan('bastion.assertion.propose'),
    controlWrite: useCan('bastion.control.write'),
  };
}

function AskAnAdmin({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="text-sm text-zinc-600 dark:text-zinc-400">
      {children}
    </p>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        {done ? <CheckCircle2 className="h-5 w-5 text-green-600" aria-label="Done" /> : <Circle className="h-5 w-5 text-zinc-400" aria-label="Not done yet" />}
        <span>
          {n}. {title}
        </span>
      </h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function ErrorLine({ err }: { err: unknown }) {
  const text = errorText(err);
  const details = technicalDetails(err);
  return text ? (
    <div>
      <p role="alert" className="text-sm text-red-600">
        {text}
      </p>
      {details && (
        <details className="text-xs text-zinc-500">
          <summary>Technical details</summary>
          {details}
        </details>
      )}
    </div>
  ) : null;
}

const btn = 'px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
const primary = `${btn} bg-primary-600 text-white hover:bg-primary-700`;
const secondary = `${btn} border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800`;

/* ------------------------------- 1. Frameworks ------------------------------- */

function FrameworksStep({ setup, perms }: { setup: SetupState; perms: SetupPermissions }) {
  const templates = useTemplates();
  const adopt = useAdoptFramework();
  const compile = useCompileFramework();
  const byTemplate = new Map(setup.frameworks.map((f) => [f.template_key, f]));
  return (
    <Step n={1} title="Choose your frameworks" done={setup.steps.frameworks.done && setup.steps.compile.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Pick the standards you are preparing for. Controls they share are set up once.
      </p>
      <ul className="space-y-3">
        {(templates.data?.data ?? []).map((t) => {
          const f = byTemplate.get(t.template_key);
          const run = f?.latest_compile_run;
          return (
            <li key={t.template_key} className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.description}</p>
                {run?.status === 'succeeded' && (
                  <p className="text-sm text-green-700 dark:text-green-400 mt-1">Checks are set up and waiting for your review.</p>
                )}
                {(run?.status === 'queued' || run?.status === 'running') && (
                  <p className="text-sm text-primary-700 dark:text-primary-400 mt-1" data-testid="compile-progress">
                    {run.status === 'queued' || !run.controls_total
                      ? "Bastion's AI is about to tailor the checks. This can take a while; you can leave this page."
                      : `Bastion's AI is tailoring the checks: ${run.controls_done ?? 0} of ${run.controls_total} controls.`}
                  </p>
                )}
                {run?.status === 'partial' && (
                  <p className="text-sm text-amber-700 mt-1">Setting up checks stopped before it finished. Start it again to pick up where it left off.</p>
                )}
              </div>
              {!f ? (
                perms.frameworkWrite && (
                  <button type="button" className={primary} disabled={adopt.isPending} onClick={() => adopt.mutate(t.template_key as BastionTemplateKey)}>
                    Adopt {t.name}
                  </button>
                )
              ) : (
                perms.compile && (
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <button
                      type="button"
                      className={run?.status === 'succeeded' ? secondary : primary}
                      disabled={compile.isPending || run?.status === 'queued' || run?.status === 'running'}
                      onClick={() => compile.mutate(f.id)}
                    >
                      {run?.status === 'succeeded' ? 'Look for new checks' : 'Set up checks'}
                    </button>
                    {run?.status !== 'queued' && run?.status !== 'running' && (
                      <button
                        type="button"
                        className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline disabled:opacity-50"
                        disabled={compile.isPending}
                        onClick={() => compile.mutate({ frameworkId: f.id, useAi: false })}
                      >
                        Use the library suggestions only
                      </button>
                    )}
                  </div>
                )
              )}
            </li>
          );
        })}
      </ul>
      {!perms.frameworkWrite && !perms.compile && <AskAnAdmin>An admin of your organization chooses the frameworks.</AskAnAdmin>}
      <ErrorLine err={adopt.error ?? compile.error} />
    </Step>
  );
}

/* --------------------------------- 2. Profile -------------------------------- */

type YesNoKey = Exclude<keyof BastionCompanyProfile, 'company_size' | 'work_style'>;

const YES_NO: Array<{ key: YesNoKey; label: string }> = [
  { key: 'has_own_premises', label: 'Do you have your own office or equipment room?' },
  { key: 'builds_software', label: 'Do you build your own software?' },
  { key: 'uses_github', label: 'Do you keep code on GitHub?' },
  { key: 'stores_customer_personal_data', label: 'Do you keep personal information about customers?' },
  { key: 'takes_card_payments', label: 'Do you take card payments?' },
  { key: 'uses_cloud_hosting', label: 'Do you run systems in the cloud?' },
  { key: 'has_contractors', label: 'Do contractors work on your systems?' },
  { key: 'issues_company_laptops', label: 'Do you give people company laptops?' },
];

function ProfileStep({ setup, perms }: { setup: SetupState; perms: SetupPermissions }) {
  const readOnly = !perms.frameworkWrite;
  const save = useSaveProfile();
  const [profile, setProfile] = useState<BastionCompanyProfile>(setup.company_profile as BastionCompanyProfile);
  const set = <K extends keyof BastionCompanyProfile>(k: K, v: BastionCompanyProfile[K]) => setProfile((p) => ({ ...p, [k]: v }));
  return (
    <Step n={2} title="About your company" done={setup.steps.profile.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Ten quick questions. They help Bastion suggest the right checks.</p>
      <label className="block text-sm">
        <span className="text-zinc-800 dark:text-zinc-200">How many people work here?</span>
        <select
          className="mt-1 block rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          disabled={readOnly}
          value={profile.company_size ?? ''}
          onChange={(e) => set('company_size', (e.target.value || undefined) as BastionCompanyProfile['company_size'])}
        >
          <option value="">Choose</option>
          <option value="1-10">1 to 10</option>
          <option value="11-50">11 to 50</option>
          <option value="51-200">51 to 200</option>
          <option value="201+">More than 200</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-zinc-800 dark:text-zinc-200">Where do people work?</span>
        <select
          className="mt-1 block rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          disabled={readOnly}
          value={profile.work_style ?? ''}
          onChange={(e) => set('work_style', (e.target.value || undefined) as BastionCompanyProfile['work_style'])}
        >
          <option value="">Choose</option>
          <option value="office">Mostly in an office</option>
          <option value="remote">Mostly remote</option>
          <option value="mixed">A mix of both</option>
        </select>
      </label>
      {YES_NO.map((q) => (
        <fieldset key={q.key} className="text-sm">
          <legend className="text-zinc-800 dark:text-zinc-200">{q.label}</legend>
          <div className="mt-1 flex gap-4">
            {[true, false].map((v) => (
              <label key={String(v)} className="flex items-center gap-1">
                <input type="radio" name={q.key} disabled={readOnly} checked={profile[q.key] === v} onChange={() => set(q.key, v)} />
                {v ? 'Yes' : 'No'}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {readOnly ? (
        <AskAnAdmin>An admin of your organization answers these questions.</AskAnAdmin>
      ) : (
        <button type="button" className={primary} disabled={save.isPending} onClick={() => save.mutate(profile)}>
          Save answers
        </button>
      )}
      {save.isSuccess && <p className="text-sm text-green-700">Saved.</p>}
      <ErrorLine err={save.error} />
    </Step>
  );
}

/* ---------------------------- 3. Compliance project --------------------------- */

function ComplianceProjectStep({ setup, perms }: { setup: SetupState; perms: SetupPermissions }) {
  const create = useCreateComplianceProject();
  const choose = useSetComplianceProject();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState('');
  const projects = useBamProjects(picking);
  const createError =
    create.error instanceof ApiError && (create.error.status === 409 || /slug|exist|duplicate/i.test(create.error.message))
      ? 'A project with that name already exists. Choose "Use an existing project" instead.'
      : errorText(create.error);
  return (
    <Step n={3} title="Compliance project (required)" done={setup.steps.compliance_project.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        When a control needs attention, Bastion files a task in this project so someone owns the fix.
      </p>
      {setup.compliance_project && (
        <p className="text-sm text-zinc-900 dark:text-zinc-100">
          Tasks go to <strong>{setup.compliance_project.name}</strong>.
        </p>
      )}
      {perms.frameworkWrite ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating...' : 'Create a "Compliance" project for me'}
          </button>
          <button type="button" className={secondary} onClick={() => setPicking(true)}>
            Use an existing project
          </button>
        </div>
      ) : (
        !setup.compliance_project && <AskAnAdmin>An admin of your organization chooses this project.</AskAnAdmin>
      )}
      {picking && perms.frameworkWrite && (
        <div className="flex items-center gap-2">
          <select
            aria-label="Existing project"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">Choose a project</option>
            {(projects.data?.data ?? [])
              .filter((p) => !p.is_archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button type="button" className={primary} disabled={!picked || choose.isPending} onClick={() => choose.mutate(picked)}>
            Use this project
          </button>
        </div>
      )}
      {createError && (
        <p role="alert" className="text-sm text-red-600">
          {createError}
        </p>
      )}
      <ErrorLine err={choose.error} />
    </Step>
  );
}

/* ------------------------------ 4. Proposed checks ----------------------------- */

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The label people see for a list member: never a raw id (spec 6.2, issue #195). */
function memberLabel(m: { value: string; label: string }, connected: Array<{ value: string; label: string }>): string {
  if (m.label && !UUID_LIKE.test(m.label)) return m.label;
  return connected.find((c) => c.value.toLowerCase() === m.value.toLowerCase())?.label ?? 'An app that is no longer tracked';
}

/**
 * The list of systems a population check covers (spec 2.1 step 5): add and remove members of
 * either kind (each change files a revision), with a plain next step when the list is empty.
 */
function PopulationEditor({
  checkId,
  pop,
  connected,
  canEdit,
  complete,
  setComplete,
}: {
  checkId: string;
  pop: PopulationView;
  connected: Array<{ value: string; label: string }>;
  canEdit: boolean;
  complete: boolean;
  setComplete: (v: boolean) => void;
}) {
  const revise = useRevisePopulation();
  const [repo, setRepo] = useState('');
  const [app, setApp] = useState('');
  const isRepos = pop.kind === 'github_repos';
  const values = pop.members.map((m) => m.value);
  const save = (next: string[], done?: () => void) => {
    setComplete(false);
    revise.mutate({ id: checkId, expected_population: next }, { onSuccess: done });
  };
  const listed = new Set(values.map((v) => v.toLowerCase()));
  const addableApps = connected.filter((c) => !listed.has(c.value.toLowerCase()));
  const emptyText = isRepos
    ? 'No repositories are listed yet. Add the repositories Bastion should check, or reject this check.'
    : connected.length === 0
      ? 'No apps are tracked in Blip yet. Add your apps in Blip first, then come back, or reject this check.'
      : 'No apps are listed yet. Add the apps Bastion should watch, or reject this check.';
  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {isRepos ? 'Repositories Bastion will check:' : 'Apps Bastion will check:'}
      </p>
      {pop.members.length === 0 ? (
        <p className="text-sm text-zinc-500" data-testid="population-empty">
          {emptyText}
        </p>
      ) : (
        <ul className="ml-5 list-disc text-sm space-y-1">
          {pop.members.map((m) => {
            const label = memberLabel(m, connected);
            return (
              <li key={m.value}>
                <span>{label}</span>
                {canEdit && (
                  <button
                    type="button"
                    className="ml-2 text-xs text-red-700 underline disabled:opacity-50"
                    aria-label={`Remove ${label}`}
                    disabled={revise.isPending}
                    onClick={() => save(values.filter((v) => v !== m.value))}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && isRepos && (
        <div className="flex gap-2">
          <input
            aria-label="Add a repository"
            placeholder="owner/name"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <button
            type="button"
            className={secondary}
            disabled={!/^[^/\s]+\/[^/\s]+$/.test(repo.trim()) || revise.isPending}
            onClick={() => save([...values, repo.trim()], () => setRepo(''))}
          >
            Add repository
          </button>
        </div>
      )}
      {canEdit && !isRepos && addableApps.length > 0 && (
        <div className="flex gap-2">
          <select
            aria-label="Add an app"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={app}
            onChange={(e) => setApp(e.target.value)}
          >
            <option value="">Choose an app</option>
            {addableApps.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <button type="button" className={secondary} disabled={!app || revise.isPending} onClick={() => save([...values, app], () => setApp(''))}>
            Add app
          </button>
        </div>
      )}
      {pop.members.length > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
          This is the complete list
        </label>
      )}
      <ErrorLine err={revise.error} />
    </div>
  );
}

function ProposedCheck({
  check,
  impersonating,
  perms,
  connected,
}: {
  check: AssertionRow;
  impersonating: boolean;
  perms: SetupPermissions;
  connected: NonNullable<SetupState['connected_populations']>;
}) {
  const confirm = useConfirmAssertion();
  const reject = useRejectAssertion();
  const [complete, setComplete] = useState(false);
  const pop = check.population;
  const canConfirm = !impersonating && (!pop || (complete && pop.members.length > 0));
  return (
    <li className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2" data-testid={`check-${check.id}`}>
      <p className="text-xs uppercase tracking-wide text-zinc-500">{check.control_title}</p>
      <p className="text-sm text-zinc-900 dark:text-zinc-100">{check.plain_statement}</p>
      {check.manual_evidence_spec && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Someone will provide: {check.manual_evidence_spec.title}</p>
      )}
      {pop && (
        <PopulationEditor
          checkId={check.id}
          pop={pop}
          connected={connected[pop.kind] ?? []}
          canEdit={perms.propose}
          complete={complete}
          setComplete={setComplete}
        />
      )}
      {perms.confirm && (
        <div className="flex gap-2">
          <button
            type="button"
            className={primary}
            disabled={!canConfirm || confirm.isPending}
            onClick={() => confirm.mutate({ id: check.id, population_confirmed: pop ? true : undefined })}
          >
            Confirm
          </button>
          <button type="button" className={secondary} disabled={impersonating || reject.isPending} onClick={() => reject.mutate(check.id)}>
            Reject
          </button>
        </div>
      )}
      <ErrorLine err={confirm.error ?? reject.error} />
    </li>
  );
}

function ReviewStep({ setup, perms }: { setup: SetupState; perms: SetupPermissions }) {
  const impersonating = getImpersonation() !== null;
  const checks = setup.proposed_checks;
  const connected = setup.connected_populations ?? { github_repos: [], blip_apps: [] };
  return (
    <Step n={4} title="Review proposed checks" done={setup.steps.review.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Bastion suggested how to check each control. Confirm the ones that fit. Anything you leave counts as "Not set up yet".
      </p>
      {impersonating && perms.confirm && (
        <p role="note" className="text-sm text-amber-700">
          You are viewing Bastion as another person. Only that person can confirm or reject checks.
        </p>
      )}
      {!perms.confirm && checks.length > 0 && (
        <AskAnAdmin>An admin of your organization confirms or rejects these checks.</AskAnAdmin>
      )}
      {checks.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing is waiting for review.</p>
      ) : (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{checks.length} checks are waiting for you.</p>
          <ul className="space-y-3">
            {checks.map((c) => (
              <ProposedCheck key={c.id} check={c} impersonating={impersonating} perms={perms} connected={connected} />
            ))}
          </ul>
        </>
      )}
    </Step>
  );
}

/* ------------------------------ 5. ISO applicability ----------------------------- */

function IsoApplicability({ framework, canDecide }: { framework: FrameworkView; canDecide: boolean }) {
  const reqs = useRequirements(framework.id);
  const decide = useDecideApplicability(framework.id);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [excluding, setExcluding] = useState<Record<string, boolean>>({});
  const rows = reqs.data?.data ?? [];
  const undecided = useMemo(() => rows.filter((r) => r.applicability === 'undecided'), [rows]);
  const decided = reqs.data?.statement_of_applicability?.decided_count ?? rows.length - undecided.length;
  const total = reqs.data?.statement_of_applicability?.requirement_count ?? rows.length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="soa-progress">
          {decided} of {total} decided
        </p>
        {canDecide && (
          <button
            type="button"
            className={secondary}
            disabled={undecided.length === 0 || decide.isPending}
            onClick={() =>
              decide.mutate({ decisions: undecided.map((r) => ({ ref_code: r.ref_code, applicability: 'applicable' as const })) })
            }
          >
            Everything else applies
          </button>
        )}
      </div>
      <ErrorLine err={decide.error} />
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.ref_code} className="py-3 space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {r.ref_code} {r.title}
                </p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">{r.plain_summary}</p>
              </div>
              <span className="text-xs text-zinc-500 whitespace-nowrap">
                {r.applicability === 'undecided' ? 'Not decided' : r.applicability === 'applicable' ? 'Applies' : 'Does not apply'}
              </span>
            </div>
            {canDecide && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={secondary}
                disabled={decide.isPending}
                onClick={() => decide.mutate({ decisions: [{ ref_code: r.ref_code, applicability: 'applicable' }] })}
              >
                Applies
              </button>
              <button type="button" className={secondary} onClick={() => setExcluding((e) => ({ ...e, [r.ref_code]: true }))}>
                Does not apply
              </button>
              {excluding[r.ref_code] && (
                <>
                  <input
                    aria-label={`Why ${r.ref_code} does not apply`}
                    placeholder="Say why this does not apply"
                    className="flex-1 min-w-[16rem] rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
                    value={reasons[r.ref_code] ?? ''}
                    onChange={(e) => setReasons((x) => ({ ...x, [r.ref_code]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className={primary}
                    disabled={!(reasons[r.ref_code] ?? '').trim() || decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        decisions: [
                          { ref_code: r.ref_code, applicability: 'not_applicable', not_applicable_reason: (reasons[r.ref_code] ?? '').trim() },
                        ],
                      })
                    }
                  >
                    Save reason
                  </button>
                </>
              )}
            </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApplicabilityStep({ setup, perms }: { setup: SetupState; perms: SetupPermissions }) {
  const iso = setup.frameworks.filter((f) => f.is_iso);
  if (iso.length === 0) return null;
  return (
    <Step n={5} title="Which ISO requirements apply to you?" done={setup.steps.applicability.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Decide every requirement. Your answers become your Statement of Applicability, which an auditor will ask for.
      </p>
      {!perms.controlWrite && <AskAnAdmin>An admin of your organization decides which requirements apply.</AskAnAdmin>}
      {iso.map((f) => (
        <IsoApplicability key={f.id} framework={f} canDecide={perms.controlWrite} />
      ))}
    </Step>
  );
}

/* ----------------------------------- Page ----------------------------------- */

export function SetupPage() {
  const setup = useSetup();
  const perms = useSetupPermissions();
  if (setup.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  if (setup.error || !setup.data) {
    return <p className="p-8 text-sm text-red-600">{errorText(setup.error) ?? 'Setup could not be loaded.'}</p>;
  }
  const s = setup.data.data;
  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Set up Bastion</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          {s.complete
            ? 'Setup is finished. You can come back here at any time.'
            : perms.frameworkWrite
              ? 'Work through these steps in order.'
              : 'Ask an admin to finish setting up Bastion. You can see where setup stands below.'}
        </p>
      </div>
      <FrameworksStep setup={s} perms={perms} />
      <ProfileStep key={JSON.stringify(s.company_profile)} setup={s} perms={perms} />
      <ComplianceProjectStep setup={s} perms={perms} />
      <ReviewStep setup={s} perms={perms} />
      <ApplicabilityStep setup={s} perms={perms} />
    </div>
  );
}
