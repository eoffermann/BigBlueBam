// railway-api.mjs
//
// Thin ESM wrapper around Railway's public GraphQL API at
// https://backboard.railway.com/graphql/v2. Used by the BigBlueBam deploy
// orchestrator to create and configure all ~19 services in one shot without
// shelling out to the `railway` CLI (which is itself just a wrapper around
// this same endpoint).
//
// Zero dependencies — only Node 22 built-ins (native fetch).
//
// Reference: https://docs.railway.com/reference/public-api
//
// Design notes:
//   - No retries, no backoff, no logging. Callers handle all of that.
//   - All GraphQL is inline as template literal strings; no .graphql files.
//   - Mutations that accept partial update inputs (serviceInstanceUpdate)
//     strip `undefined` fields because Railway rejects unknown nulls.

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';

/**
 * Typed error for anything that goes wrong talking to Railway.
 *
 * `kind` is a coarse classification so callers can decide whether to prompt
 * the user to re-auth, retry, or surface a raw GraphQL error:
 *   - 'auth'    : 401/403 from the HTTP layer (bad/expired PAT)
 *   - 'network' : fetch rejected, or non-2xx that isn't 401/403
 *   - 'graphql' : HTTP 2xx but the body contained a top-level `errors` array
 *   - 'unknown' : catch-all for anything we didn't anticipate
 */
export class RailwayApiError extends Error {
  constructor(message, { kind = 'unknown', errors = null, status = null, request = null } = {}) {
    super(message);
    this.name = 'RailwayApiError';
    this.kind = kind;
    this.errors = errors;
    this.status = status;
    this.request = request;
  }
}

/**
 * Remove keys whose value is `undefined`. We deliberately keep `null` because
 * Railway treats explicit null as "clear this field" in some inputs, whereas
 * undefined means "don't touch it". Callers pass undefined for "don't touch".
 */
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class RailwayClient {
  constructor(token) {
    if (!token || typeof token !== 'string') {
      throw new RailwayApiError('RailwayClient requires a non-empty token string', { kind: 'auth' });
    }
    this.token = token;
    this.endpoint = RAILWAY_GRAPHQL_ENDPOINT;
  }

  /**
   * Low-level GraphQL POST. Every other method funnels through here so error
   * classification lives in exactly one place.
   */
  async query(query, variables = {}) {
    const body = JSON.stringify({ query, variables });
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      // fetch() rejects on DNS failures, connection resets, TLS errors, etc.
      // Wrap so callers only ever catch RailwayApiError.
      throw new RailwayApiError(`Railway request failed: ${err?.message ?? String(err)}`, {
        kind: 'network',
        request: { query, variables },
      });
    }

    if (!res.ok) {
      // 401/403 almost always means the PAT is bad or lacks scope; split that
      // out so the orchestrator can give a precise "re-auth please" message.
      const kind = res.status === 401 || res.status === 403 ? 'auth' : 'network';
      let text = '';
      try {
        text = await res.text();
      } catch {
        // ignore — the status code is the real signal
      }
      throw new RailwayApiError(`Railway HTTP ${res.status}: ${text || res.statusText}`, {
        kind,
        status: res.status,
        request: { query, variables },
      });
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new RailwayApiError(`Railway returned non-JSON body: ${err?.message ?? String(err)}`, {
        kind: 'unknown',
        status: res.status,
        request: { query, variables },
      });
    }

    if (json?.errors && Array.isArray(json.errors) && json.errors.length > 0) {
      const first = json.errors[0]?.message ?? 'Unknown GraphQL error';
      throw new RailwayApiError(`Railway GraphQL error: ${first}`, {
        kind: 'graphql',
        errors: json.errors,
        status: res.status,
        request: { query, variables },
      });
    }

    return json?.data ?? {};
  }

  /**
   * Cheap token validation. Callers invoke this first so the orchestrator can
   * fail fast with a clean error before spending minutes provisioning.
   */
  async whoami() {
    const data = await this.query(`{ me { email name } }`);
    const me = data?.me ?? {};
    return { email: me.email ?? null, name: me.name ?? null };
  }

  async listProjects() {
    // `deletedAt` is requested so we can filter out soft-deleted projects.
    // Railway's API returns projects in a "trash" / grace-period state for
    // some time after the operator clicks Delete; if we don't filter them
    // the orchestrator sees stale duplicates and the operator gets a
    // confusing "Found N projects named …" error for projects they think
    // they already deleted.
    const data = await this.query(`
      {
        me {
          projects(first: 200) {
            edges {
              node { id name deletedAt }
            }
          }
        }
      }
    `);
    const edges = data?.me?.projects?.edges ?? [];
    return edges
      .map((e) => e?.node)
      .filter(Boolean)
      .filter((n) => !n.deletedAt)
      .map((n) => ({ id: n.id, name: n.name }));
  }

  /**
   * List projects scoped to a specific workspace. Necessary because Railway's
   * `me { projects }` query has not historically returned every project the
   * user has access to across every workspace — projects in team workspaces
   * (or workspaces created after the personal one) can be missing from the
   * top-level list, which causes findProjectByName to return null and the
   * orchestrator to silently create duplicate projects on re-runs.
   *
   * We try the workspace-scoped query first via `me { workspaces { projects } }`,
   * which matches Railway's current schema. If the GraphQL server rejects the
   * `projects` sub-selection (older / different schema), we fall back to the
   * top-level `me.projects` list — that's still better than nothing.
   */
  async listProjectsInWorkspace(workspaceId) {
    if (!workspaceId) return this.listProjects();
    // `deletedAt` is requested so we can filter out soft-deleted projects.
    // See the listProjects() comment for why.
    try {
      const data = await this.query(`
        {
          me {
            workspaces {
              id
              projects {
                edges {
                  node { id name deletedAt }
                }
              }
            }
          }
        }
      `);
      const workspaces = data?.me?.workspaces ?? [];
      const ws = workspaces.find((w) => w?.id === workspaceId);
      if (!ws) return [];
      const edges = ws.projects?.edges ?? [];
      return edges
        .map((e) => e?.node)
        .filter(Boolean)
        .filter((n) => !n.deletedAt)
        .map((n) => ({ id: n.id, name: n.name }));
    } catch (err) {
      if (err instanceof RailwayApiError && err.kind === 'graphql') {
        // Schema doesn't expose projects under workspaces — fall back.
        return this.listProjects();
      }
      throw err;
    }
  }

  /**
   * Find a project by name. When `workspaceId` is provided, restrict the
   * lookup to that workspace; otherwise fall back to the global `me.projects`
   * list. Returns the first match, or null.
   *
   * Returning the first match is intentional: if there are multiple projects
   * with the same name in the same workspace, callers should detect that with
   * `findProjectsByName` and prompt the operator. This entry point is for the
   * common case where there's exactly one.
   */
  async findProjectByName(name, { workspaceId } = {}) {
    const matches = await this.findProjectsByName(name, { workspaceId });
    return matches[0] ?? null;
  }

  /**
   * Find ALL projects with a given name, optionally scoped to a workspace.
   * Used by the orchestrator to detect duplicate-name situations and warn
   * the operator instead of silently picking one.
   */
  async findProjectsByName(name, { workspaceId } = {}) {
    const projects = workspaceId
      ? await this.listProjectsInWorkspace(workspaceId)
      : await this.listProjects();
    return projects.filter((p) => p.name === name);
  }

  /**
   * List the workspaces the authenticated user belongs to. Railway's
   * ProjectCreateInput now requires workspaceId — it used to be optional and
   * default to the user's personal workspace, but as of the Railway API
   * schema revision that shipped around 2025-11, passing null or omitting it
   * returns "You must specify a workspaceId to create a project."
   *
   * Every Railway user has at least one workspace — the personal workspace,
   * auto-created on signup. Team accounts may have additional workspaces.
   *
   * Returns: [{ id, name, team?: { id } }, ...]. `team` is present for
   * team-backed workspaces (older concept); personal workspaces omit it.
   *
   * Note: Railway's `me { workspaces }` returns a direct list (not a Relay
   * connection), so the query shape is simpler than `me { projects }`.
   */
  async listWorkspaces() {
    const data = await this.query(`
      {
        me {
          workspaces {
            id
            name
            team { id }
          }
        }
      }
    `);
    const rows = data?.me?.workspaces ?? [];
    return rows
      .filter(Boolean)
      .map((w) => ({
        id: w.id,
        name: w.name ?? 'unnamed workspace',
        team: w.team ?? null,
      }));
  }

  /**
   * Create a project and resolve its default environment in one call.
   * The deploy flow always needs the env ID immediately afterward (to create
   * service instances and push variables), so bundling the lookup here keeps
   * the orchestrator code short.
   */
  async createProject({ name, description, workspaceId, defaultEnvironmentName = 'production' } = {}) {
    const input = stripUndefined({
      name,
      description,
      workspaceId,
      defaultEnvironmentName,
    });
    const data = await this.query(
      `
      mutation projectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) { id name }
      }
      `,
      { input },
    );
    const project = data?.projectCreate ?? {};
    const env = await this.getDefaultEnvironment(project.id);
    return {
      id: project.id,
      name: project.name,
      defaultEnvironmentId: env?.id ?? null,
      defaultEnvironmentName: env?.name ?? null,
    };
  }

  /**
   * Fetch "the" environment we should deploy to. Railway creates a
   * `production` env by default; if a user has renamed it or deleted it we
   * fall back to whichever env comes first rather than crashing.
   */
  async getDefaultEnvironment(projectId) {
    const data = await this.query(
      `
      query projectEnvironments($id: String!) {
        project(id: $id) {
          environments {
            edges {
              node { id name }
            }
          }
        }
      }
      `,
      { id: projectId },
    );
    const edges = data?.project?.environments?.edges ?? [];
    const nodes = edges.map((e) => e?.node).filter(Boolean);
    if (nodes.length === 0) return null;
    const prod = nodes.find((n) => n.name === 'production');
    const pick = prod ?? nodes[0];
    return { id: pick.id, name: pick.name };
  }

  async listServices(projectId) {
    const data = await this.query(
      `
      query projectServices($id: String!) {
        project(id: $id) {
          services {
            edges {
              node { id name }
            }
          }
        }
      }
      `,
      { id: projectId },
    );
    const edges = data?.project?.services?.edges ?? [];
    return edges
      .map((e) => e?.node)
      .filter(Boolean)
      .map((n) => ({ id: n.id, name: n.name }));
  }

  async findServiceByName(projectId, name) {
    const services = await this.listServices(projectId);
    return services.find((s) => s.name === name) ?? null;
  }

  // ─── Log fetching ──────────────────────────────────────────────────────
  //
  // Railway's GraphQL API exposes deployments and their logs, but the
  // public schema isn't extensively documented and field names have
  // changed over the years. We use the shapes that match Railway's
  // current public schema as of 2025-Q4; if a query shape changes we
  // fall through to a clear error so the caller can decide what to do.
  //
  // These are used by pullRailwayLogs (platforms/railway.mjs) to
  // automatically download build + runtime logs for every service in a
  // project to local files on deploy failure — so agents like Claude can
  // grep/read them without the operator manually running `railway logs`
  // for every service individually.

  /**
   * List the latest N deployments for a specific service, most-recent
   * first. Returns an array of { id, status, createdAt, meta } objects.
   *
   * Railway's deployments query takes a filter input object. Passing an
   * empty/default input returns everything; narrowing by projectId +
   * environmentId + serviceId is the normal per-service lookup.
   */
  async listServiceDeployments({ projectId, environmentId, serviceId, limit = 1 } = {}) {
    const data = await this.query(
      `
      query svcDeployments($input: DeploymentListInput!, $first: Int!) {
        deployments(input: $input, first: $first) {
          edges {
            node {
              id
              status
              createdAt
              staticUrl
              meta
            }
          }
        }
      }
      `,
      {
        input: { projectId, environmentId, serviceId },
        first: limit,
      },
    );
    const edges = data?.deployments?.edges ?? [];
    return edges
      .map((e) => e?.node)
      .filter(Boolean)
      .map((n) => ({
        id: n.id,
        status: n.status ?? null,
        createdAt: n.createdAt ?? null,
        staticUrl: n.staticUrl ?? null,
        meta: n.meta ?? null,
      }));
  }

  /**
   * Fetch build logs for a given deployment ID. Returns an array of
   * { timestamp, severity, message } objects. Railway's buildLogs query
   * returns the build output line-by-line; if a build is in-progress we
   * get whatever's been emitted so far.
   */
  async fetchBuildLogs(deploymentId, { limit = 5000 } = {}) {
    const data = await this.query(
      `
      query buildLogs($deploymentId: String!, $limit: Int) {
        buildLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          severity
          message
        }
      }
      `,
      { deploymentId, limit },
    );
    const logs = Array.isArray(data?.buildLogs) ? data.buildLogs : [];
    return logs.map((l) => ({
      timestamp: l?.timestamp ?? null,
      severity: l?.severity ?? null,
      message: l?.message ?? '',
    }));
  }

  /**
   * Fetch runtime (deploy) logs for a given deployment ID. Same shape as
   * fetchBuildLogs. These are the logs from the running container.
   */
  async fetchDeploymentLogs(deploymentId, { limit = 5000 } = {}) {
    const data = await this.query(
      `
      query deploymentLogs($deploymentId: String!, $limit: Int) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          severity
          message
        }
      }
      `,
      { deploymentId, limit },
    );
    const logs = Array.isArray(data?.deploymentLogs) ? data.deploymentLogs : [];
    return logs.map((l) => ({
      timestamp: l?.timestamp ?? null,
      severity: l?.severity ?? null,
      message: l?.message ?? '',
    }));
  }

  /**
   * Idempotent: returns the existing service if one with this name already
   * exists under the project. This matters because the deploy script is
   * designed to be re-runnable — partial failures shouldn't produce
   * duplicate services on retry.
   *
   * `source` is either `{ repo: "owner/name" }` or `{ image: "redis:7-alpine" }`.
   * Railway's ServiceCreateInput nests the source object directly under
   * `source` on the input.
   */
  async createService({ projectId, name, source, branch, variables } = {}) {
    const existing = await this.findServiceByName(projectId, name);
    if (existing) return existing;

    const input = stripUndefined({
      projectId,
      name,
      source,
      branch,
      variables,
    });
    const data = await this.query(
      `
      mutation serviceCreate($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }
      `,
      { input },
    );
    const svc = data?.serviceCreate ?? {};
    return { id: svc.id, name: svc.name };
  }

  /**
   * Update the per-environment instance config for a service: build command,
   * root dir, Dockerfile path, start command, healthcheck, replicas, region,
   * restart policy. Any undefined field is stripped so we never accidentally
   * clobber settings the caller didn't mean to touch.
   */
  async updateServiceInstance({
    serviceId,
    environmentId,
    rootDirectory,
    dockerfilePath,
    startCommand,
    healthcheckPath,
    restartPolicyType,
    restartPolicyMaxRetries,
    numReplicas,
    region,
    buildCommand,
  } = {}) {
    const input = stripUndefined({
      rootDirectory,
      dockerfilePath,
      startCommand,
      healthcheckPath,
      restartPolicyType,
      restartPolicyMaxRetries,
      numReplicas,
      region,
      buildCommand,
    });
    await this.query(
      `
      mutation serviceInstanceUpdate(
        $serviceId: String!
        $environmentId: String!
        $input: ServiceInstanceUpdateInput!
      ) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
      `,
      { serviceId, environmentId, input },
    );
    return true;
  }

  /**
   * Create + attach a persistent volume to a service at `mountPath`. Without
   * this, self-hosted stateful services (minio, qdrant) store their data on the
   * container's ephemeral filesystem and LOSE EVERYTHING on every redeploy/
   * restart. A service can hold only one volume, so re-runs raise an
   * already-exists GraphQL error — the orchestrator treats that as success.
   */
  async createVolume({ projectId, environmentId, serviceId, mountPath } = {}) {
    const input = stripUndefined({ projectId, environmentId, serviceId, mountPath });
    const data = await this.query(
      `
      mutation volumeCreate($input: VolumeCreateInput!) {
        volumeCreate(input: $input) { id }
      }
      `,
      { input },
    );
    return data?.volumeCreate ?? null;
  }

  /**
   * Bulk upsert variables. Defaulting `skipDeploys=true` is deliberate: the
   * orchestrator pushes dozens of variables per service and we want a single
   * deploy at the end instead of one auto-deploy per variable change.
   *
   * `serviceId` may be null for shared/project-level variables.
   */
  async upsertVariables({ projectId, environmentId, serviceId, variables, replace = false, skipDeploys = true } = {}) {
    const input = stripUndefined({
      projectId,
      environmentId,
      serviceId,
      variables,
      replace,
      skipDeploys,
    });
    await this.query(
      `
      mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
      `,
      { input },
    );
    return true;
  }

  /**
   * Read the resolved variable collection for a service in an environment.
   * Returns a plain { KEY: value } object (Railway's `variables` query returns
   * a JSON scalar). Used by the reconcile flow to diff live values against the
   * catalog-computed values so we only re-push (and only redeploy) when a
   * deploy-owned variable has actually drifted — e.g. a stale
   * `API_INTERNAL_URL=...:4000` that predates the :8080 port convention.
   *
   * `serviceId` may be omitted for shared/project-level variables.
   */
  async getServiceVariables({ projectId, environmentId, serviceId } = {}) {
    const data = await this.query(
      `
      query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }
      `,
      { projectId, environmentId, serviceId },
    );
    const vars = data?.variables;
    return vars && typeof vars === 'object' ? vars : {};
  }

  /**
   * Create a TCP proxy for a service so an internal container port is reachable
   * from the public internet on a Railway-assigned (random) external port.
   * Used to expose LiveKit's TURN-TLS relay (container :5349) without the
   * operator hand-creating the proxy in the dashboard. Returns
   * { id, domain, proxyPort, applicationPort }. Idempotent at the caller level
   * (callers check listTcpProxies first) — Railway itself will create a second
   * proxy if asked twice, so do NOT call this blindly.
   */
  async createTcpProxy({ environmentId, serviceId, applicationPort } = {}) {
    const input = stripUndefined({ environmentId, serviceId, applicationPort });
    const data = await this.query(
      `
      mutation tcpProxyCreate($input: TCPProxyCreateInput!) {
        tcpProxyCreate(input: $input) {
          id
          domain
          proxyPort
          applicationPort
        }
      }
      `,
      { input },
    );
    const p = data?.tcpProxyCreate ?? {};
    return {
      id: p.id ?? null,
      domain: p.domain ?? null,
      proxyPort: p.proxyPort ?? null,
      applicationPort: p.applicationPort ?? null,
    };
  }

  /**
   * List existing TCP proxies for a service instance. Used to make TURN-proxy
   * creation idempotent — if a proxy targeting the application port already
   * exists we reuse its public port instead of creating a duplicate.
   */
  async listTcpProxies({ environmentId, serviceId } = {}) {
    const data = await this.query(
      `
      query tcpProxies($environmentId: String!, $serviceId: String!) {
        tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
          id
          domain
          proxyPort
          applicationPort
        }
      }
      `,
      { environmentId, serviceId },
    );
    const rows = Array.isArray(data?.tcpProxies) ? data.tcpProxies : [];
    return rows.filter(Boolean).map((p) => ({
      id: p.id ?? null,
      domain: p.domain ?? null,
      proxyPort: p.proxyPort ?? null,
      applicationPort: p.applicationPort ?? null,
    }));
  }

  async triggerDeploy({ projectId, environmentId, serviceId } = {}) {
    const input = stripUndefined({ projectId, environmentId, serviceId });
    await this.query(
      `
      mutation environmentTriggersDeploy($input: EnvironmentTriggersDeployInput!) {
        environmentTriggersDeploy(input: $input)
      }
      `,
      { input },
    );
    return true;
  }

  /**
   * Introspect the Mutation type and verify the mutations we depend on still
   * exist by name. Railway has changed mutation names before (notably around
   * service/instance splits), so we run this as a preflight before the
   * orchestrator starts provisioning. Never throws — an introspection
   * failure is returned as `{ ok: false, missing: ['(introspection failed)'] }`
   * so the caller can print the underlying error itself.
   */
  async assertSchemaCompatibility() {
    const required = [
      'projectCreate',
      'serviceCreate',
      'serviceInstanceUpdate',
      'variableCollectionUpsert',
      'environmentTriggersDeploy',
    ];
    let data;
    try {
      data = await this.query(`{ __type(name: "Mutation") { fields { name } } }`);
    } catch {
      return { ok: false, missing: ['(introspection failed)'] };
    }
    const fields = data?.__type?.fields ?? [];
    const present = new Set(fields.map((f) => f?.name).filter(Boolean));
    const missing = required.filter((r) => !present.has(r));
    return { ok: missing.length === 0, missing };
  }
}
