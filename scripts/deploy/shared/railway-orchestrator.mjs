// railway-orchestrator.mjs
//
// High-level "deploy the whole BigBlueBam stack to Railway" logic. This is
// the data-flow layer: it walks the service catalog, computes the env-var
// bundle each service needs, and calls the RailwayClient (railway-api.mjs)
// to provision and configure every service end-to-end. It does NOT make
// any retry decisions, print anything, or block on user input directly —
// all of that is delegated to the caller via the onProgress callback and
// the optional awaitPluginConfirmation callback.
//
// Zero external dependencies.
//
// Re-run safety: every Railway mutation we invoke is idempotent by design
// (RailwayClient.createService returns the existing service by name,
// updateServiceInstance only touches the fields we pass, upsertVariables
// with replace=false merges instead of clobbering). That means if the
// orchestrator aborts halfway through, the caller can simply run it again
// and it will pick up where it left off.

import {
  getRequiredAppServices,
  getSelfHostedInfra,
  JOB_SERVICES,
} from './services.mjs';
import { hintFor, isAuthoritativeKind } from './env-hints.mjs';

// ─── Plan assembly ────────────────────────────────────────────────────
//
// The deploy plan is a flat, ordered list of services to create. Order
// matters for the progress UI (users see a stable list) but not for
// functional correctness — Railway resolves inter-service references
// lazily at deploy time, so creating bolt-api before its dependency
// mcp-server is fine.

function buildDeployPlan() {
  const appServices = getRequiredAppServices().filter(
    // TODO: voice-agent is optional and depends on whether the user wants
    // voice/video. For now we never include it in the automated deploy —
    // users who want it can add it manually from the Railway dashboard.
    (s) => s.name !== 'voice-agent',
  );
  const selfHostedInfra = getSelfHostedInfra();
  // JOB_SERVICES (currently just `migrate`) get created as regular Railway
  // services with restart policy NEVER — Railway doesn't have a separate
  // "job" primitive, but a service with restart=NEVER runs exactly once
  // per deploy and then stays in the "exited" state, which is what we want.
  return [...appServices, ...selfHostedInfra, ...JOB_SERVICES];
}

// ─── Variable resolution ──────────────────────────────────────────────
//
// For every env var declared in a service's catalog entry, ask env-hints
// what kind of value it is (plugin ref, generated secret, user integration,
// derived internal URL, …) and resolve it to a concrete string — or skip
// it if we can't compute it yet (the user will fill it in later in the
// Railway dashboard). Required vars that can't be resolved are a hard
// error; optional vars that can't be resolved are silently skipped.

/**
 * Build the { KEY: value } object for a single service.
 *
 * Exposed as a named export so the caller (and tests) can inspect the
 * computed bundle without running the full orchestrator.
 */
export function buildServiceVariables(service, context) {
  const { generatedSecrets = {}, publicUrl = null, userIntegrations = {} } = context ?? {};
  const out = {};

  const required = service?.env?.required ?? [];
  const optional = service?.env?.optional ?? [];

  // Resolve a single variable. Returns either a string (the value to set)
  // or the sentinel symbol SKIP meaning "we can't compute this now, leave
  // it unset on Railway and let the user fill it in later".
  const SKIP = Symbol('skip');
  const resolve = (name) => {
    const hint = hintFor(name);
    switch (hint.kind) {
      case 'plugin':
      case 'reference':
      case 'computed':
      case 'literal':
        // These are all literal strings in the hint — Railway itself
        // resolves plugin/reference syntax at runtime (${{Postgres...}}),
        // and computed/literal values are already concrete.
        return hint.value;

      case 'secret': {
        // Generated locally and passed in via context. If the caller
        // didn't generate this secret, we have no way to conjure one —
        // skip. (If this was a required var, the caller validates later.)
        const v = generatedSecrets[name];
        return v !== undefined && v !== null && v !== '' ? v : SKIP;
      }

      case 'public': {
        // Needs the frontend's public URL. On the first deploy we don't
        // know it yet (Railway assigns a domain after the service exists),
        // so we skip and let the user set it in the dashboard on round 2.
        if (!publicUrl) return SKIP;
        // Strip trailing slash before substituting so hints like
        // `<frontend-public-url>/b3` produce `https://host.up.railway.app/b3`
        // not `https://host.up.railway.app//b3`.
        const base = publicUrl.replace(/\/+$/, '');
        const template = String(hint.value);
        return template.replace('<frontend-public-url>', base);
      }

      case 'user': {
        // OAuth / SMTP / etc. — comes from outside. Empty string means
        // "the user chose to skip this integration"; treat as SKIP.
        const v = userIntegrations[name];
        return v !== undefined && v !== null && v !== '' ? v : SKIP;
      }

      case 'note':
      case 'unknown':
      default:
        // `note` hints are documentation only (e.g. HTTP_PORT explaining
        // that Railway assigns the port automatically), and `unknown`
        // means env-hints has no idea what to do. Either way, skip.
        return SKIP;
    }
  };

  // Edge case: MinIO and LiveKit generated secrets are SET on those
  // services themselves, not just referenced from app services. Their
  // catalog entries declare MINIO_ROOT_USER etc. as required, and the
  // generic `secret` branch above already handles that because the
  // generatedSecrets context contains these keys. No special-casing
  // needed here as long as the caller passes them through.

  for (const name of required) {
    const v = resolve(name);
    if (v === SKIP) {
      // Required vars MUST be resolvable. If we hit this it means either
      // (a) the caller forgot to pass a generated secret, (b) a required
      // var is marked `user` or `public` in env-hints (that's a bug in
      // the hints or in the catalog), or (c) env-hints has no entry at all.
      throw new Error(
        `Cannot resolve required variable "${name}" for service "${service.name}". ` +
          `Check generatedSecrets, userIntegrations, publicUrl, and env-hints.mjs.`,
      );
    }
    out[name] = v;
  }

  for (const name of optional) {
    const v = resolve(name);
    if (v !== SKIP) out[name] = v;
  }

  // Sort keys for stable output — makes diffs readable and the variable
  // upsert payloads deterministic between runs.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

/**
 * The deploy-owned ("authoritative") subset of a service's variables: those
 * whose value is a pure function of the catalog (computed/literal/plugin/
 * reference per env-hints). These are the only variables the reconcile flow
 * may OVERWRITE on a live service, because if they drift they are always
 * wrong — this is the class that produced the API_INTERNAL_URL=:4000 outage.
 * Secrets, public URLs, and user integrations are deliberately excluded so a
 * rotated secret or custom domain is never clobbered.
 *
 * Resolved DIRECTLY from the hints (not via buildServiceVariables) so it needs
 * no secret/public/integration context and cannot throw on an unresolved
 * required secret — authoritative kinds are always concrete literals in the
 * hint. This keeps `reconcile()` decoupled from the operator's secret bundle.
 *
 * Exposed for the orchestrator's reconcile() and for tests.
 */
export function buildAuthoritativeVariables(service) {
  const required = service?.env?.required ?? [];
  const optional = service?.env?.optional ?? [];
  const out = {};
  for (const name of [...required, ...optional]) {
    const hint = hintFor(name);
    if (isAuthoritativeKind(hint.kind)) out[name] = hint.value;
  }
  // Stable key order for deterministic diffs / upsert payloads.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

/**
 * Diff a service's desired authoritative variables against the live values.
 * Returns { changed: { KEY: { from, to } }, missing: { KEY: to } } where
 * `changed` is keys whose live value differs and `missing` is keys absent
 * live. Both together are what reconcile would push. Pure — no I/O.
 */
export function diffAuthoritativeVariables(desired, live) {
  const changed = {};
  const missing = {};
  for (const [k, to] of Object.entries(desired)) {
    if (!(k in live)) {
      missing[k] = to;
    } else if (live[k] !== to) {
      changed[k] = { from: live[k], to };
    }
  }
  return { changed, missing };
}

// ─── Orchestrator ─────────────────────────────────────────────────────

export class RailwayOrchestrator {
  constructor(client, options = {}) {
    if (!client) throw new Error('RailwayOrchestrator requires a RailwayClient instance');
    this.client = client;

    const {
      projectName,
      workspaceId = null,
      githubRepo,
      branch,
      generatedSecrets = {},
      publicUrl = null,
      userIntegrations = {},
      onProgress = () => {},
      awaitPluginConfirmation = null,
    } = options;

    if (!projectName || typeof projectName !== 'string') {
      throw new Error('RailwayOrchestrator requires options.projectName');
    }
    if (!githubRepo || typeof githubRepo !== 'string') {
      throw new Error('RailwayOrchestrator requires options.githubRepo (e.g. "user/repo")');
    }
    if (!branch || typeof branch !== 'string') {
      throw new Error('RailwayOrchestrator requires options.branch');
    }

    this.projectName = projectName;
    this.workspaceId = workspaceId;
    this.githubRepo = githubRepo;
    this.branch = branch;
    this.generatedSecrets = generatedSecrets;
    this.publicUrl = publicUrl;
    this.userIntegrations = userIntegrations;
    this.onProgress = onProgress;
    this.awaitPluginConfirmation = awaitPluginConfirmation;

    // Filled in by _phaseProject().
    this.projectId = null;
    this.defaultEnvironmentId = null;

    // Filled in by _phaseServices(). Map<serviceName, serviceId>.
    this.serviceIds = new Map();

    // Filled in by _buildPlan() during run().
    this.plan = [];

    // Step counter — increments as we emit progress. We precompute the
    // total in run() once we know the plan length.
    this.step = 0;
    this.total = 0;
  }

  // Emit a progress event. Swallows any error from the callback itself so
  // a buggy UI can't bring down the deploy.
  _emit(event) {
    try {
      this.onProgress(event);
    } catch {
      // ignore — progress reporting is best-effort
    }
  }

  // Convenience: emit a "starting" event and a "finished" event around an
  // async operation, with ok/error set appropriately. Re-throws on error
  // so the caller of _step() still sees the failure.
  async _step(phase, message, fn, extra = {}) {
    this.step += 1;
    const base = { phase, step: this.step, total: this.total, message, ...extra };
    this._emit({ ...base });
    try {
      const result = await fn();
      this._emit({ ...base, ok: true });
      return result;
    } catch (err) {
      this._emit({ ...base, ok: false, error: err });
      throw err;
    }
  }

  // ─── Phase 1: validate ──────────────────────────────────────────────
  async _phaseValidate() {
    await this._step('project', 'Checking Railway API schema compatibility', async () => {
      const compat = await this.client.assertSchemaCompatibility();
      if (!compat.ok) {
        // Naming every missing mutation gives the user enough to search
        // Railway's docs or changelog for a rename.
        throw new Error(
          `Railway GraphQL schema is missing required mutations: ${compat.missing.join(', ')}. ` +
            `This usually means Railway renamed a mutation — check https://docs.railway.com/reference/public-api ` +
            `and update scripts/deploy/shared/railway-api.mjs.`,
        );
      }
    });

    await this._step('project', 'Verifying Railway API token', async () => {
      const me = await this.client.whoami();
      // Pass the identity through so the UI can display a "logged in as
      // foo@bar.com" confirmation before we start burning user quota.
      this._emit({
        phase: 'project',
        step: this.step,
        total: this.total,
        message: `Authenticated as ${me.email ?? me.name ?? 'unknown user'}`,
        ok: true,
        identity: me,
      });
    });
  }

  // ─── Phase 2: project ───────────────────────────────────────────────
  async _phaseProject() {
    // Lookup MUST be workspace-scoped — Railway's `me.projects` query does
    // not reliably return projects across every workspace, so without the
    // workspaceId filter we'd silently miss the existing project and create
    // a duplicate (which then has no Postgres/Redis databases attached and
    // every Bam app dies on `${{Postgres.DATABASE_URL}}` resolving to nothing).
    const matches = await this._step(
      'project',
      `Looking for an existing project named "${this.projectName}" in this workspace`,
      async () =>
        this.client.findProjectsByName(this.projectName, {
          workspaceId: this.workspaceId,
        }),
    );

    if (matches.length > 1) {
      // Don't silently pick when there's ambiguity — surface it so the
      // operator can clean up the duplicates and re-run unambiguously.
      // Soft-deleted projects are already filtered out at the API layer
      // (see listProjects / listProjectsInWorkspace `deletedAt` check),
      // so anything we surface here is a real, live project.
      const links = matches
        .map((m) => `      • https://railway.com/project/${m.id}`)
        .join('\n');
      throw new Error(
        `Found ${matches.length} live projects named "${this.projectName}" in this workspace.\n\n` +
          `  Open each one in your browser and decide which to keep:\n${links}\n\n` +
          `  Then either:\n` +
          `    (a) Delete every duplicate so only one "${this.projectName}" project remains, OR\n` +
          `    (b) Rename the ones you want to keep so this script can match exactly one.\n\n` +
          `  After cleanup, re-run this script.`,
      );
    }

    if (matches.length === 1) {
      await this._step(
        'project',
        `Reusing existing project "${this.projectName}" (${matches[0].id})`,
        async () => {
          this.projectId = matches[0].id;
          const env = await this.client.getDefaultEnvironment(this.projectId);
          if (!env) {
            throw new Error(
              `Project "${this.projectName}" exists but has no environments — create one in the Railway dashboard.`,
            );
          }
          this.defaultEnvironmentId = env.id;
        },
        { summary: { projectId: matches[0].id, action: 'reused' } },
      );
      return;
    }

    await this._step(
      'project',
      `No existing "${this.projectName}" project found in this workspace — creating a new one`,
      async () => {
        const created = await this.client.createProject({
          name: this.projectName,
          workspaceId: this.workspaceId ?? undefined,
        });
        this.projectId = created.id;
        this.defaultEnvironmentId = created.defaultEnvironmentId;
        if (!this.defaultEnvironmentId) {
          throw new Error(
            `Created project "${this.projectName}" but could not resolve a default environment.`,
          );
        }
      },
    );
  }

  // ─── Phase 3: database prompt (Postgres + Redis) ────────────────────
  async _phaseDatabasePrompt() {
    // Railway's public GraphQL API does NOT expose database provisioning
    // (you can't templateDeploy Postgres/Redis as a regular operator),
    // so we can't add them automatically. Instead we emit a prompt event
    // and, if the caller wired one, await their confirmation callback.
    //
    // TODO: investigate whether Railway's `templateDeploy` mutation works
    // for 'postgres' and 'redis' template codes at the public-API level.
    // If yes, we can skip this manual step entirely. Tracked as a
    // follow-up — for now the text below is written for clarity and
    // accuracy against Railway's current dashboard UI.
    this.step += 1;
    this._emit({
      phase: 'database-prompt',
      step: this.step,
      total: this.total,
      message:
        'Waiting for you to add a PostgreSQL database and a Redis database in the Railway dashboard.',
    });
    if (typeof this.awaitPluginConfirmation === 'function') {
      // Caller-supplied async gate — typically a `confirm()` CLI prompt.
      // (Historically named awaitPluginConfirmation — renaming the
      // callback is a breaking API change, so keeping the old name.)
      await this.awaitPluginConfirmation();
    }
    // If no confirmation callback was provided we assume the caller has
    // already added the databases (or is running in an automated context
    // where they are pre-provisioned).
    this._emit({
      phase: 'database-prompt',
      step: this.step,
      total: this.total,
      message: 'Databases confirmed',
      ok: true,
    });
  }

  // ─── Phase 4: services (create + configure + set vars) ─────────────
  async _phaseServices() {
    // Shared context for buildServiceVariables — built once up front so
    // every service sees the same snapshot of secrets and integrations.
    const varContext = {
      generatedSecrets: this.generatedSecrets,
      publicUrl: this.publicUrl,
      userIntegrations: this.userIntegrations,
    };

    for (const svc of this.plan) {
      // ── Create
      const created = await this._step(
        'service-create',
        `Creating service "${svc.name}"`,
        async () => {
          // Source: if the service has a Dockerfile we build from the
          // GitHub repo (all our services use this branch because even
          // the infra services have a passthrough Dockerfile). If it has
          // an `image` but no `dockerfile`, fall back to image source —
          // this branch isn't hit by the current catalog but is kept as
          // a safety net for future infra entries.
          const source = svc.dockerfile
            ? { repo: this.githubRepo }
            : svc.image
              ? { image: svc.image }
              : null;
          if (!source) {
            throw new Error(`Service "${svc.name}" has neither a dockerfile nor an image.`);
          }
          return this.client.createService({
            projectId: this.projectId,
            name: svc.name,
            source,
            // Only pass branch for repo-based services; image-based
            // services don't have a branch concept.
            branch: svc.dockerfile ? this.branch : undefined,
          });
        },
        { service: svc.name },
      );
      this.serviceIds.set(svc.name, created.id);

      // ── Configure (dockerfile path, start command, healthcheck, restart)
      await this._step(
        'service-config',
        `Configuring service "${svc.name}"`,
        async () => {
          const isJob = JOB_SERVICES.includes(svc);
          await this.client.updateServiceInstance({
            serviceId: created.id,
            environmentId: this.defaultEnvironmentId,
            // All our Dockerfiles expect the monorepo root as the build
            // context (they COPY apps/<name>/... and packages/shared/...),
            // so rootDirectory is always '.' regardless of service.
            rootDirectory: '.',
            dockerfilePath: svc.dockerfile ?? undefined,
            startCommand: svc.start_command ?? undefined,
            healthcheckPath: svc.healthcheck ?? undefined,
            // Jobs run once and exit on purpose — don't restart them.
            // App services get the same ON_FAILURE policy as the
            // generated railway/*.json configs.
            restartPolicyType: isJob ? 'NEVER' : 'ON_FAILURE',
            restartPolicyMaxRetries: isJob ? undefined : 10,
          });
        },
        { service: svc.name },
      );

      // ── Variables
      await this._step(
        'service-vars',
        `Setting variables for "${svc.name}"`,
        async () => {
          const variables = buildServiceVariables(svc, varContext);
          if (Object.keys(variables).length === 0) {
            // Nothing to set — frontend/site/voice-agent fall in this
            // bucket. Skip the API call entirely.
            return;
          }
          await this.client.upsertVariables({
            projectId: this.projectId,
            environmentId: this.defaultEnvironmentId,
            serviceId: created.id,
            variables,
            // skipDeploys=true (default in the client) because we trigger
            // exactly one deploy per service at the end of the run.
            skipDeploys: true,
          });
        },
        { service: svc.name },
      );
    }
  }

  // ─── Phase 5: trigger deploys ──────────────────────────────────────
  async _phaseDeploy() {
    for (const svc of this.plan) {
      const serviceId = this.serviceIds.get(svc.name);
      if (!serviceId) continue; // shouldn't happen, but be defensive
      await this._step(
        'deploy-trigger',
        `Triggering deploy for "${svc.name}"`,
        async () => {
          await this.client.triggerDeploy({
            projectId: this.projectId,
            environmentId: this.defaultEnvironmentId,
            serviceId,
          });
        },
        { service: svc.name },
      );
    }
  }

  // ─── Public entry point ────────────────────────────────────────────
  async run() {
    // Build the plan once so _phaseServices and _phaseDeploy iterate the
    // exact same list in the exact same order.
    this.plan = buildDeployPlan();

    // Total progress steps = 2 (validate: compat + whoami)
    //                      + 1 (project)
    //                      + 1 (plugin prompt)
    //                      + 3 * plan.length (create + config + vars per service)
    //                      + plan.length (deploy trigger per service)
    //                      + 1 (done).
    // The caller uses these for a progress bar; the exact number doesn't
    // need to match Railway's own internals, it just needs to be stable.
    this.total = 2 + 1 + 1 + 4 * this.plan.length + 1;
    this.step = 0;

    await this._phaseValidate();
    await this._phaseProject();
    await this._phaseDatabasePrompt();
    await this._phaseServices();
    await this._phaseDeploy();

    const summary = {
      projectId: this.projectId,
      environmentId: this.defaultEnvironmentId,
      servicesCreated: this.serviceIds.size,
      servicesConfigured: this.serviceIds.size,
      servicesDeployed: this.serviceIds.size,
    };

    this.step += 1;
    this._emit({
      phase: 'done',
      step: this.step,
      total: this.total,
      message: `Deployed ${summary.servicesCreated} services to project ${this.projectId}`,
      ok: true,
      summary,
    });

    return summary;
  }

  // ─── Reconcile (self-heal drifted deploy-owned variables) ───────────
  //
  // Re-pushes the authoritative (catalog-computed) variables to every
  // already-deployed service, overwriting any that have drifted — e.g. a
  // stale internal URL left behind by an older port/host convention. Does
  // NOT create services, does NOT touch secrets / public URLs / user
  // integrations, and only redeploys the services that actually changed.
  //
  // This is the safety net for the failure mode where the live stack was
  // first provisioned under an older catalog and never re-provisioned, so a
  // computed value (like API_INTERNAL_URL) is frozen at a now-wrong value.
  //
  // Options: { dryRun = false, onlyServices = null }. With dryRun it reports
  // the diff without writing anything. onlyServices is an optional array of
  // service names to limit the scope.
  async reconcile({ dryRun = false, onlyServices = null } = {}) {
    await this._phaseValidate();
    await this._phaseProject();

    const liveServices = await this.client.listServices(this.projectId);
    const liveByName = new Map(liveServices.map((s) => [s.name, s.id]));

    const plan = buildDeployPlan().filter((svc) => {
      if (onlyServices && !onlyServices.includes(svc.name)) return false;
      return liveByName.has(svc.name);
    });

    const report = [];
    for (const svc of plan) {
      const serviceId = liveByName.get(svc.name);
      const desired = buildAuthoritativeVariables(svc);
      if (Object.keys(desired).length === 0) continue;

      const live = await this.client.getServiceVariables({
        projectId: this.projectId,
        environmentId: this.defaultEnvironmentId,
        serviceId,
      });
      const { changed, missing } = diffAuthoritativeVariables(desired, live);
      const toPush = { ...missing };
      for (const [k, { to }] of Object.entries(changed)) toPush[k] = to;

      const drift = Object.keys(toPush);
      if (drift.length === 0) {
        report.push({ service: svc.name, changed: {}, missing: {}, applied: false });
        this._emit({ phase: 'reconcile', service: svc.name, message: `${svc.name}: in sync`, ok: true });
        continue;
      }

      this._emit({
        phase: 'reconcile',
        service: svc.name,
        message: `${svc.name}: ${drift.length} var(s) drifted — ${drift.join(', ')}`,
        ok: true,
        changed,
        missing,
      });

      if (!dryRun) {
        // replace:false merges — it overwrites exactly the keys we send and
        // leaves every operator-owned secret/integration untouched.
        await this.client.upsertVariables({
          projectId: this.projectId,
          environmentId: this.defaultEnvironmentId,
          serviceId,
          variables: toPush,
          skipDeploys: true,
        });
        await this.client.triggerDeploy({
          projectId: this.projectId,
          environmentId: this.defaultEnvironmentId,
          serviceId,
        });
      }
      report.push({ service: svc.name, changed, missing, applied: !dryRun });
    }

    const driftedCount = report.filter((r) => Object.keys(r.changed).length || Object.keys(r.missing).length).length;
    this._emit({
      phase: 'reconcile-done',
      message: dryRun
        ? `Reconcile (dry run): ${driftedCount} service(s) would change`
        : `Reconcile complete: ${driftedCount} service(s) corrected and redeployed`,
      ok: true,
      summary: { dryRun, driftedCount, report },
    });
    return { dryRun, driftedCount, report };
  }

  // ─── Post-deploy smoke verification ─────────────────────────────────
  //
  // Probes the live stack through the PUBLIC ingress to catch the failure
  // class the per-service Railway healthcheck cannot: a service that is green
  // on localhost:8080 but whose OUTBOUND internal URL is wrong (the
  // API_INTERNAL_URL=:4000 outage was exactly this — every dashboard tile
  // healthy while the MCP→api hop was dead).
  //
  // checks (best-effort, each independent):
  //   - ingress root reachable
  //   - Bam api reachable via ingress (/b3/api/public/config)
  //   - mcp-server reachable via ingress (/mcp/ → 401 without a token proves up)
  //   - if `token` given: the MCP→api hop, by running a real streamable-HTTP
  //     handshake + get_me through /mcp/ and asserting the profile resolves.
  //
  // Returns { ok, checks: [{ name, ok, detail }] }. Never throws — a probe
  // error is just a failed check so the caller decides whether to hard-fail.
  async verify({ publicUrl, token = null, timeoutMs = 12000 } = {}) {
    if (!publicUrl) {
      return { ok: false, checks: [{ name: 'publicUrl', ok: false, detail: 'no public URL to probe' }] };
    }
    const base = publicUrl.replace(/\/+$/, '');

    const probe = async (url, init = {}) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        return { status: res.status, ok: res.ok, body: res };
      } catch (err) {
        return { status: 0, ok: false, error: err?.message ?? String(err) };
      } finally {
        clearTimeout(t);
      }
    };

    const checks = [];
    const record = (name, ok, detail) => {
      checks.push({ name, ok, detail });
      this._emit({ phase: 'verify', message: `${name}: ${detail}`, ok });
    };

    // 1. Ingress root.
    {
      const r = await probe(`${base}/`);
      record('ingress', r.status > 0 && r.status < 500, r.error ? `unreachable (${r.error})` : `HTTP ${r.status}`);
    }
    // 2. Bam api via ingress — /public/config is unauthenticated.
    {
      const r = await probe(`${base}/b3/api/public/config`);
      record('bam-api', r.ok, r.error ? `unreachable (${r.error})` : `HTTP ${r.status}`);
    }
    // 3. mcp-server up via ingress. Without a token the server replies 401 —
    //    that IS the success signal (it proves ingress→mcp resolves).
    {
      const r = await probe(`${base}/mcp/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const up = r.status === 401 || r.status === 400 || r.ok;
      record('mcp-server', up, r.error ? `unreachable (${r.error})` : `HTTP ${r.status}`);
    }
    // 4. MCP→api hop (only with a token). A full streamable-HTTP handshake:
    //    initialize → capture mcp-session-id → notifications/initialized →
    //    tools/call get_me. Success = the profile resolves, which is only
    //    possible if the mcp-server can reach the api internally.
    if (token) {
      const ok = await this._verifyMcpApiHop(base, token, probe);
      record('mcp→api hop', ok.ok, ok.detail);
    } else {
      record('mcp→api hop', true, 'skipped (no verify token provided)');
    }

    const ok = checks.every((c) => c.ok);
    this._emit({ phase: 'verify-done', message: ok ? 'All smoke checks passed' : 'Smoke checks FAILED', ok, summary: { checks } });
    return { ok, checks };
  }

  // Run the streamable-HTTP handshake + get_me through the public /mcp/ path
  // with a bearer token. Returns { ok, detail }. Used by verify().
  async _verifyMcpApiHop(base, token, probe) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const initBody = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'deploy-verify', version: '1.0' } },
    });
    const init = await probe(`${base}/mcp/`, { method: 'POST', headers, body: initBody });
    if (!init.ok || !init.body) return { ok: false, detail: init.error ? `initialize failed (${init.error})` : `initialize HTTP ${init.status}` };
    const sessionId = init.body.headers?.get?.('mcp-session-id');
    if (!sessionId) return { ok: false, detail: 'no mcp-session-id returned from initialize' };

    const sessHeaders = { ...headers, 'mcp-session-id': sessionId };
    await probe(`${base}/mcp/`, {
      method: 'POST', headers: sessHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const callBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_me', arguments: {} } });
    const call = await probe(`${base}/mcp/`, { method: 'POST', headers: sessHeaders, body: callBody });
    if (!call.ok || !call.body) return { ok: false, detail: call.error ? `get_me failed (${call.error})` : `get_me HTTP ${call.status}` };
    let text = '';
    try { text = await call.body.text(); } catch { /* ignore */ }
    // The mcp-server surfaces an upstream connect failure as "fetch failed"
    // inside the tool result — the exact symptom of a broken internal URL.
    if (/fetch failed/i.test(text)) return { ok: false, detail: 'mcp-server reached but its upstream api fetch failed (internal URL likely wrong)' };
    if (/"error"/.test(text) && !/"email"/.test(text)) return { ok: false, detail: 'get_me returned an error (token or hop problem)' };
    return { ok: true, detail: 'get_me resolved through the MCP→api hop' };
  }
}
