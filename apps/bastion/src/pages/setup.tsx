import { useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { BastionCompanyProfile, BastionTemplateKey } from '@bigbluebam/shared';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import { ApiError, type AssertionRow, type FrameworkView, type SetupState } from '@/lib/api';
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

function errorText(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
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
  return text ? (
    <p role="alert" className="text-sm text-red-600">
      {text}
    </p>
  ) : null;
}

const btn = 'px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
const primary = `${btn} bg-primary-600 text-white hover:bg-primary-700`;
const secondary = `${btn} border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800`;

/* ------------------------------- 1. Frameworks ------------------------------- */

function FrameworksStep({ setup }: { setup: SetupState }) {
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
              </div>
              {!f ? (
                <button type="button" className={primary} disabled={adopt.isPending} onClick={() => adopt.mutate(t.template_key as BastionTemplateKey)}>
                  Adopt {t.name}
                </button>
              ) : (
                <button type="button" className={run?.status === 'succeeded' ? secondary : primary} disabled={compile.isPending} onClick={() => compile.mutate(f.id)}>
                  {run?.status === 'succeeded' ? 'Look for new checks' : 'Set up checks'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
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

function ProfileStep({ setup }: { setup: SetupState }) {
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
                <input type="radio" name={q.key} checked={profile[q.key] === v} onChange={() => set(q.key, v)} />
                {v ? 'Yes' : 'No'}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button type="button" className={primary} disabled={save.isPending} onClick={() => save.mutate(profile)}>
        Save answers
      </button>
      {save.isSuccess && <p className="text-sm text-green-700">Saved.</p>}
      <ErrorLine err={save.error} />
    </Step>
  );
}

/* ---------------------------- 3. Compliance project --------------------------- */

function ComplianceProjectStep({ setup }: { setup: SetupState }) {
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
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating...' : 'Create a "Compliance" project for me'}
        </button>
        <button type="button" className={secondary} onClick={() => setPicking(true)}>
          Use an existing project
        </button>
      </div>
      {picking && (
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

function ProposedCheck({ check, impersonating }: { check: AssertionRow; impersonating: boolean }) {
  const confirm = useConfirmAssertion();
  const reject = useRejectAssertion();
  const revise = useRevisePopulation();
  const [complete, setComplete] = useState(false);
  const [addition, setAddition] = useState('');
  const pop = check.population;
  const isRepos = pop?.kind === 'github_repos';
  const canConfirm = !impersonating && (!pop || (complete && pop.members.length > 0));
  return (
    <li className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2" data-testid={`check-${check.id}`}>
      <p className="text-xs uppercase tracking-wide text-zinc-500">{check.control_title}</p>
      <p className="text-sm text-zinc-900 dark:text-zinc-100">{check.plain_statement}</p>
      {check.manual_evidence_spec && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Someone will provide: {check.manual_evidence_spec.title}</p>
      )}
      {pop && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {isRepos ? 'Repositories Bastion will check:' : 'Apps Bastion will check:'}
          </p>
          {pop.members.length === 0 ? (
            <p className="text-sm text-zinc-500">None yet. Add every one that should be checked.</p>
          ) : (
            <ul className="list-disc ml-5 text-sm">
              {pop.members.map((m) => (
                <li key={m.value}>{m.label}</li>
              ))}
            </ul>
          )}
          {isRepos && (
            <div className="flex gap-2">
              <input
                aria-label="Add a repository"
                placeholder="owner/name"
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
                value={addition}
                onChange={(e) => setAddition(e.target.value)}
              />
              <button
                type="button"
                className={secondary}
                disabled={!/^[^/\s]+\/[^/\s]+$/.test(addition.trim()) || revise.isPending}
                onClick={() =>
                  revise.mutate(
                    { id: check.id, expected_population: [...pop.members.map((m) => m.value), addition.trim()] },
                    { onSuccess: () => setAddition('') },
                  )
                }
              >
                Add repository
              </button>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            This is the complete list
          </label>
        </div>
      )}
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
      <ErrorLine err={confirm.error ?? reject.error ?? revise.error} />
    </li>
  );
}

function ReviewStep({ setup }: { setup: SetupState }) {
  const impersonating = getImpersonation() !== null;
  const checks = setup.proposed_checks;
  return (
    <Step n={4} title="Review proposed checks" done={setup.steps.review.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Bastion suggested how to check each control. Confirm the ones that fit. Anything you leave counts as "Not set up yet".
      </p>
      {impersonating && (
        <p role="note" className="text-sm text-amber-700">
          You are viewing Bastion as another person. Only that person can confirm or reject checks.
        </p>
      )}
      {checks.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing is waiting for review.</p>
      ) : (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{checks.length} checks are waiting for you.</p>
          <ul className="space-y-3">
            {checks.map((c) => (
              <ProposedCheck key={c.id} check={c} impersonating={impersonating} />
            ))}
          </ul>
        </>
      )}
    </Step>
  );
}

/* ------------------------------ 5. ISO applicability ----------------------------- */

function IsoApplicability({ framework }: { framework: FrameworkView }) {
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
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApplicabilityStep({ setup }: { setup: SetupState }) {
  const iso = setup.frameworks.filter((f) => f.is_iso);
  if (iso.length === 0) return null;
  return (
    <Step n={5} title="Which ISO requirements apply to you?" done={setup.steps.applicability.done}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Decide every requirement. Your answers become your Statement of Applicability, which an auditor will ask for.
      </p>
      {iso.map((f) => (
        <IsoApplicability key={f.id} framework={f} />
      ))}
    </Step>
  );
}

/* ----------------------------------- Page ----------------------------------- */

export function SetupPage() {
  const setup = useSetup();
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
          {s.complete ? 'Setup is finished. You can come back here at any time.' : 'Work through these steps in order.'}
        </p>
      </div>
      <FrameworksStep setup={s} />
      <ProfileStep key={JSON.stringify(s.company_profile)} setup={s} />
      <ComplianceProjectStep setup={s} />
      <ReviewStep setup={s} />
      <ApplicabilityStep setup={s} />
    </div>
  );
}
