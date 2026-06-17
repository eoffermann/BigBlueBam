import { test as setup, request as playwrightRequest } from '@playwright/test';
import { loginViaUI, readCsrfTokenFromCookies } from './auth.helper';
import { TEST_USERS } from './test-users';
import { DirectApiClient, ApiClientError } from '../api/api-client';
import path from 'node:path';

const AUTH_DIR = path.join(__dirname, '..', '..', '.auth');
const ADMIN_STATE = path.join(AUTH_DIR, 'admin.json');

// Seed steps read ADMIN_STATE; force serial so 'authenticate as admin' writes
// the file BEFORE any seed step opens it.
setup.describe.configure({ mode: 'serial' });

setup('authenticate as admin', async ({ page }) => {
  await loginViaUI(page, TEST_USERS.admin);
  // Mark the first-time-user experience complete for the admin so the guided
  // Settings tour doesn't hijack every b3 functional test (the FTUE fires for
  // any account whose notification_prefs.ftue_completed is unset). The dedicated
  // FTUE spec exercises the tour itself via the otherwise-unused member account.
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf_token')?.value;
  const res = await page.request.patch('/b3/api/auth/me', {
    headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    data: { notification_prefs: { ftue_completed: true } },
  });
  if (!res.ok()) {
    console.warn(`[setup] mark admin FTUE complete failed: ${res.status()}`);
  }
  await page.context().storageState({ path: ADMIN_STATE });
});

setup('authenticate as member', async ({ page }) => {
  await loginViaUI(page, TEST_USERS.member);
  await page.context().storageState({ path: path.join(AUTH_DIR, 'member.json') });
});

// ---------------------------------------------------------------------------
// Helper — build a DirectApiClient for a given per-app base path, sharing the
// admin storage state & CSRF token. Each seed step creates its own apiContext
// (Playwright's APIRequestContext is not trivially shareable across test
// workers), then disposes of it in a `finally`.
// ---------------------------------------------------------------------------
async function makeAdminApi(
  baseURL: string | undefined,
  apiBasePath: string,
): Promise<{ api: DirectApiClient; dispose: () => Promise<void> }> {
  const apiContext = await playwrightRequest.newContext({
    baseURL,
    storageState: ADMIN_STATE,
  });
  const storage = await apiContext.storageState();
  const csrf = readCsrfTokenFromCookies(storage.cookies);
  const api = new DirectApiClient(apiContext, apiBasePath, csrf || undefined);
  return {
    api,
    dispose: async () => {
      await apiContext.dispose();
    },
  };
}

/**
 * Idempotent seed helper — list `listPath` first and only create via
 * `createPath` + `createBody` if the list returns an empty array.
 * Accepts an optional `extract` function to pluck the rows out of a wrapping
 * envelope shape (e.g. `{data: rows, total, ...}`).
 *
 * Silent-exits on list failures so a down service never blocks authentication
 * for tests that don't touch that app.
 */
async function seedIfEmpty<TItem = { id: string; name?: string }>(
  label: string,
  api: DirectApiClient,
  listPath: string,
  createPath: string,
  createBody: Record<string, unknown>,
  extract?: (raw: unknown) => TItem[] | undefined,
): Promise<void> {
  let existing: TItem[] = [];
  try {
    const raw = await api.get<unknown>(listPath);
    if (extract) {
      existing = extract(raw) ?? [];
    } else if (Array.isArray(raw)) {
      existing = raw as TItem[];
    } else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
      existing = (raw as { data: TItem[] }).data;
    }
  } catch (err) {
    if (err instanceof ApiClientError) {
      console.warn(`[seed] ${label}: list at ${listPath} failed (${err.status}); skipping seed step.`);
    } else {
      console.warn(`[seed] ${label}: list at ${listPath} threw; skipping seed step.`);
    }
    return;
  }

  if (existing.length > 0) {
    console.log(`[seed] ${label}: ${existing.length} already exist — using existing.`);
    return;
  }

  try {
    await api.post(createPath, createBody);
    console.log(`[seed] ${label}: created new entity via ${createPath}.`);
  } catch (err) {
    const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
    console.warn(`[seed] ${label}: create at ${createPath} failed — ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Bam (b3) — at least one project for the e2e admin. Project template creates
// phases automatically so the board renders real columns.
// ---------------------------------------------------------------------------
setup('seed e2e admin project', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/b3/api');
  try {
    const existing = await api.get<Array<{ id: string; name: string }>>('/projects');
    if (existing.length > 0) {
      console.log(
        `[seed] e2e admin already has ${existing.length} project(s); ` +
          `using existing (${existing[0].name}).`,
      );
      return;
    }

    const created = await api.post<{ id: string; name: string }>('/projects', {
      name: 'E2E Test Project',
      description: 'Created by e2e auth setup — safe to delete if empty.',
      // task_id_prefix regex is ^[A-Z]{2,6}$ — must be uppercase A-Z only,
      // which is why this is 'EEE' and not 'E2E'.
      task_id_prefix: 'EEE',
    });
    console.log(`[seed] Created e2e admin project ${created.name} (${created.id}).`);
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Bam (b3) — ensure the first project has a task in its first phase so that
// drag-drop / reorder / ui-api-agreement / pagination tests have rows to
// exercise.
// ---------------------------------------------------------------------------
setup('seed e2e admin tasks', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/b3/api');
  try {
    const projects = await api.get<Array<{ id: string; name: string }>>('/projects');
    if (projects.length === 0) {
      console.warn('[seed] tasks: no project found, cannot seed tasks');
      return;
    }
    const projectId = projects[0].id;

    // The list endpoint returns a cursor-paginated envelope `{items, ...}`
    // or raw array depending on version — normalize both.
    let existingTasks: Array<{ id: string }> = [];
    try {
      const raw = await api.get<unknown>(`/projects/${projectId}/tasks`, { limit: 5 });
      if (Array.isArray(raw)) {
        existingTasks = raw as Array<{ id: string }>;
      } else if (raw && typeof raw === 'object') {
        const maybeItems = (raw as { items?: unknown }).items;
        if (Array.isArray(maybeItems)) {
          existingTasks = maybeItems as Array<{ id: string }>;
        }
      }
    } catch {}

    if (existingTasks.length >= 2) {
      console.log(`[seed] tasks: project already has ${existingTasks.length} task(s).`);
      return;
    }

    // Need at least 2 tasks for the reorder drag test to run, so create a
    // small handful. Each POST goes through the normal validation path.
    const needed = 3 - existingTasks.length;
    for (let i = 0; i < needed; i++) {
      try {
        await api.post(`/projects/${projectId}/tasks`, {
          title: `E2E Seed Task ${i + 1}`,
          description: 'Created by e2e auth setup — safe to delete.',
        });
      } catch (err) {
        const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
        console.warn(`[seed] tasks: create failed — ${msg}`);
        return;
      }
    }
    console.log(`[seed] tasks: created ${needed} task(s) in project ${projectId}.`);
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Board — at least one board with at least one sticky element. Uses
// `visibility: 'organization'` to avoid the project_id requirement. A sticky
// is seeded so canvas-interactions tests ("drag element", "delete element")
// have something to target.
// ---------------------------------------------------------------------------
setup('seed e2e admin board', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/board/api');
  try {
    const unwrap = (raw: unknown): Array<{ id: string }> => {
      if (Array.isArray(raw)) return raw as Array<{ id: string }>;
      if (raw && typeof raw === 'object') {
        const items = (raw as { items?: unknown; data?: unknown }).items ?? (raw as { data?: unknown }).data;
        if (Array.isArray(items)) return items as Array<{ id: string }>;
      }
      return [];
    };

    // Board
    let boards: Array<{ id: string }> = [];
    try {
      boards = unwrap(await api.get<unknown>('/v1/boards'));
    } catch (err) {
      console.warn(`[seed] board: list failed — ${String(err)}`);
      return;
    }

    let boardId: string | undefined = boards[0]?.id;
    if (!boardId) {
      try {
        const created = await api.post<{ id: string }>('/v1/boards', {
          name: 'E2E Seed Board',
          visibility: 'organization',
        });
        boardId = created.id;
        console.log(`[seed] board: created board ${boardId}.`);
      } catch (err) {
        const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
        console.warn(`[seed] board: create failed — ${msg}`);
        return;
      }
    } else {
      console.log(`[seed] board: ${boards.length} board(s) already exist.`);
    }

    // Elements — ensure at least one sticky note on the board
    if (!boardId) return;
    try {
      const elementsRaw = await api.get<unknown>(`/v1/boards/${boardId}/elements`);
      const elements = unwrap(elementsRaw);
      if (elements.length > 0) {
        console.log(`[seed] board: ${elements.length} element(s) already exist.`);
        return;
      }
      await api.post(`/v1/boards/${boardId}/elements/sticky`, {
        text: 'E2E seed sticky',
        x: 100,
        y: 100,
      });
      console.log('[seed] board: created sticky.');
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
      console.warn(`[seed] board: element seed failed — ${msg}`);
    }
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Bolt — at least one automation. Uses a valid trigger_source/trigger_event
// pair and a single action referencing a real MCP tool name so validation
// passes. trigger_source:'bam' + trigger_event:'task.created' is the most
// boring possible event shape.
// ---------------------------------------------------------------------------
setup('seed e2e admin automation', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/bolt/api');
  try {
    await seedIfEmpty(
      'automation',
      api,
      '/v1/automations',
      '/v1/automations',
      {
        name: 'E2E Seed Automation',
        description: 'Created by e2e auth setup — safe to delete.',
        enabled: false,
        trigger_source: 'bam',
        trigger_event: 'task.created',
        actions: [
          {
            sort_order: 0,
            mcp_tool: 'create_task',
            parameters: {},
          },
        ],
      },
      (raw) => {
        if (Array.isArray(raw)) return raw as Array<{ id: string }>;
        if (raw && typeof raw === 'object') {
          const items = (raw as { items?: unknown; data?: unknown }).items ?? (raw as { data?: unknown }).data;
          if (Array.isArray(items)) return items as Array<{ id: string }>;
        }
        return [];
      },
    );
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Bond — pipeline with stages, company, contact, deal. Deals REQUIRE a
// pipeline_id AND a stage_id, so we create the pipeline with stages first,
// then seed a deal referencing the first stage.
// ---------------------------------------------------------------------------
setup('seed e2e admin bond', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/bond/api');
  try {
    // KNOWN BOND-API BUG: GET /v1/pipelines crashes with `malformed array
    // literal` (Postgres 22P02) whenever ANY pipeline exists — the
    // listPipelines service passes a single-element JS array into a raw
    // `ANY(${ids})` sql template without encoding it as a Postgres array
    // literal. Fixing it requires editing bond-api/src/services/pipeline.service.ts
    // which is out of scope for this e2e-only task. We work around by
    // probing /v1/deals first: if any deal already exists, we know a
    // pipeline+stage pair exists and reuse them. Only on a completely
    // empty bond install do we attempt the /v1/pipelines POST to create
    // a fresh one (at which point /v1/pipelines list may start 500-ing
    // on every subsequent run — but the deal-based reuse path keeps the
    // seed idempotent).
    let pipelineId: string | undefined;
    let stageId: string | undefined;

    try {
      const rawDeals = await api.get<any>('/v1/deals');
      const deals = Array.isArray(rawDeals)
        ? rawDeals
        : Array.isArray(rawDeals?.data)
          ? rawDeals.data
          : [];
      if (deals.length > 0 && deals[0].pipeline_id && deals[0].stage_id) {
        pipelineId = deals[0].pipeline_id;
        stageId = deals[0].stage_id;
        console.log(`[seed] bond: reusing pipeline ${pipelineId} from existing deal.`);
      }
    } catch {}

    if (!pipelineId) {
      // No deals yet — attempt to read pipelines (may 500 if already poisoned)
      // or create a new one.
      let pipelines: Array<{ id: string; stages?: Array<{ id: string }> }> = [];
      try {
        pipelines = await api.get<Array<{ id: string; stages?: Array<{ id: string }> }>>('/v1/pipelines');
      } catch {
        // /v1/pipelines is broken but we have no deals — try to create a
        // new pipeline directly; createPipeline does not use the broken
        // list query.
      }

      if (pipelines.length === 0) {
        try {
          const created = await api.post<{ id: string; stages?: Array<{ id: string }> }>('/v1/pipelines', {
            name: 'E2E Seed Pipeline',
            description: 'Created by e2e auth setup — safe to delete.',
            stages: [
              { name: 'Lead', sort_order: 0, stage_type: 'active', probability_pct: 10 },
              { name: 'Qualified', sort_order: 1, stage_type: 'active', probability_pct: 30 },
              { name: 'Proposal', sort_order: 2, stage_type: 'active', probability_pct: 60 },
              { name: 'Won', sort_order: 3, stage_type: 'won', probability_pct: 100 },
            ],
          });
          pipelineId = created.id;
          stageId = created.stages?.[0]?.id;
          console.log(`[seed] bond: created pipeline ${pipelineId}.`);
        } catch (err) {
          const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
          console.warn(`[seed] bond: create pipeline failed — ${msg}`);
        }
      } else {
        pipelineId = pipelines[0].id;
        stageId = pipelines[0].stages?.[0]?.id;
        if (!stageId) {
          try {
            const detail = await api.get<{ id: string; stages?: Array<{ id: string }> }>(`/v1/pipelines/${pipelineId}`);
            stageId = detail.stages?.[0]?.id;
          } catch {}
        }
      }
    }

    // Company — unwrapping {data: rows, total, ...}
    await seedIfEmpty(
      'bond company',
      api,
      '/v1/companies',
      '/v1/companies',
      { name: 'E2E Seed Company' },
      (raw) => {
        if (Array.isArray(raw)) return raw as Array<{ id: string }>;
        if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
          return (raw as { data: Array<{ id: string }> }).data;
        }
        return [];
      },
    );

    // Contact
    await seedIfEmpty(
      'bond contact',
      api,
      '/v1/contacts',
      '/v1/contacts',
      { first_name: 'E2ESeed', last_name: 'Contact', email: 'e2e-seed@test.local' },
      (raw) => {
        if (Array.isArray(raw)) return raw as Array<{ id: string }>;
        if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
          return (raw as { data: Array<{ id: string }> }).data;
        }
        return [];
      },
    );

    // Deal — requires pipeline + stage
    if (pipelineId && stageId) {
      let deals: Array<{ id: string }> = [];
      try {
        const raw = await api.get<unknown>('/v1/deals');
        if (Array.isArray(raw)) deals = raw as Array<{ id: string }>;
        else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
          deals = (raw as { data: Array<{ id: string }> }).data;
        }
      } catch {}

      if (deals.length === 0) {
        try {
          await api.post('/v1/deals', {
            name: 'E2E Seed Deal',
            pipeline_id: pipelineId,
            stage_id: stageId,
            value: 10000,
          });
          console.log('[seed] bond: created deal.');
        } catch (err) {
          const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
          console.warn(`[seed] bond: create deal failed — ${msg}`);
        }
      } else {
        console.log(`[seed] bond: ${deals.length} deal(s) already exist.`);
      }
    } else {
      console.warn('[seed] bond: no pipeline+stage available, skipping deal seed.');
    }
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Brief — at least one published document so "document detail" test can hit
// `/v1/documents/:id`.
// ---------------------------------------------------------------------------
setup('seed e2e admin brief document', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/brief/api');
  try {
    let existing: Array<{ id: string }> = [];
    try {
      const raw = await api.get<unknown>('/v1/documents');
      if (Array.isArray(raw)) existing = raw as Array<{ id: string }>;
      else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
        existing = (raw as { data: Array<{ id: string }> }).data;
      }
    } catch (err) {
      console.warn(`[seed] brief: list failed, skipping — ${String(err)}`);
      return;
    }

    if (existing.length > 0) {
      console.log(`[seed] brief: ${existing.length} document(s) already exist.`);
      return;
    }

    try {
      // Brief createDocumentSchema accepts only title + a few optional
      // metadata fields; content is added post-create via PATCH
      // /v1/documents/:id/content. A bare title is enough for the detail
      // page to render.
      await api.post('/v1/documents', {
        title: 'E2E Seed Document',
        visibility: 'organization',
      });
      console.log('[seed] brief: created document.');
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
      console.warn(`[seed] brief: create failed — ${msg}`);
    }
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Banter — Banter auto-creates #general on first list call, so normally
// channels are non-empty. Still, defensively create an e2e channel if none
// exist after the list call (some environments may have membership gaps).
// ---------------------------------------------------------------------------
setup('seed e2e admin banter channel', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/banter/api');
  try {
    let channels: Array<{ id: string; slug?: string }> = [];
    try {
      const raw = await api.get<unknown>('/v1/channels');
      if (Array.isArray(raw)) channels = raw as Array<{ id: string }>;
      else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
        channels = (raw as { data: Array<{ id: string }> }).data;
      }
    } catch (err) {
      console.warn(`[seed] banter: list failed — ${String(err)}`);
      return;
    }

    if (channels.length > 0) {
      console.log(`[seed] banter: ${channels.length} channel(s) already exist.`);
      return;
    }

    try {
      await api.post('/v1/channels', {
        name: 'e2e-seed',
        type: 'public',
        description: 'E2E seed channel',
      });
      console.log('[seed] banter: created channel.');
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
      console.warn(`[seed] banter: create channel failed — ${msg}`);
    }
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Blank — at least one form. Slug must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$.
// ---------------------------------------------------------------------------
setup('seed e2e admin form', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/blank/api');
  try {
    await seedIfEmpty(
      'blank form',
      api,
      '/v1/forms',
      '/v1/forms',
      {
        name: 'E2E Seed Form',
        slug: 'e2e-seed-form',
        description: 'Created by e2e auth setup — safe to delete.',
        form_type: 'internal',
        visibility: 'org',
      },
      (raw) => {
        if (Array.isArray(raw)) return raw as Array<{ id: string }>;
        if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
          return (raw as { data: Array<{ id: string }> }).data;
        }
        return [];
      },
    );
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Bill — at least one client and one invoice (client is prerequisite for
// invoice).
// ---------------------------------------------------------------------------
setup('seed e2e admin bill client + invoice', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/bill/api');
  try {
    // Client
    let clients: Array<{ id: string }> = [];
    try {
      const raw = await api.get<unknown>('/v1/clients');
      if (Array.isArray(raw)) clients = raw as Array<{ id: string }>;
      else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
        clients = (raw as { data: Array<{ id: string }> }).data;
      }
    } catch (err) {
      console.warn(`[seed] bill: list clients failed — ${String(err)}`);
      return;
    }

    let clientId: string | undefined = clients[0]?.id;
    if (!clientId) {
      try {
        const created = await api.post<{ id: string }>('/v1/clients', { name: 'E2E Seed Client' });
        clientId = created.id;
        console.log('[seed] bill: created client.');
      } catch (err) {
        const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
        console.warn(`[seed] bill: create client failed — ${msg}`);
      }
    } else {
      console.log(`[seed] bill: client already exists.`);
    }

    // Invoice (only if we have a client)
    if (!clientId) return;

    let invoices: Array<{ id: string }> = [];
    try {
      const raw = await api.get<unknown>('/v1/invoices');
      if (Array.isArray(raw)) invoices = raw as Array<{ id: string }>;
      else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
        invoices = (raw as { data: Array<{ id: string }> }).data;
      }
    } catch {}

    if (invoices.length > 0) {
      console.log(`[seed] bill: ${invoices.length} invoice(s) already exist.`);
      return;
    }

    try {
      await api.post('/v1/invoices', {
        client_id: clientId,
      });
      console.log('[seed] bill: created invoice.');
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err);
      console.warn(`[seed] bill: create invoice failed — ${msg}`);
    }
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Blast — at least one template and one campaign.
// ---------------------------------------------------------------------------
setup('seed e2e admin blast template + campaign', async ({ baseURL }) => {
  const { api, dispose } = await makeAdminApi(baseURL, '/blast/api');
  try {
    // Template
    await seedIfEmpty(
      'blast template',
      api,
      '/v1/templates',
      '/v1/templates',
      {
        name: 'E2E Seed Template',
        subject_template: 'E2E Seed Subject',
        html_body: '<p>E2E seed body</p>',
        template_type: 'campaign',
      },
      (raw) => {
        if (Array.isArray(raw)) return raw as Array<{ id: string }>;
        if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
          return (raw as { data: Array<{ id: string }> }).data;
        }
        return [];
      },
    );

    // Campaign
    await seedIfEmpty(
      'blast campaign',
      api,
      '/v1/campaigns',
      '/v1/campaigns',
      {
        name: 'E2E Seed Campaign',
        subject: 'E2E Seed Campaign Subject',
        html_body: '<p>E2E seed campaign body</p>',
      },
      (raw) => {
        if (Array.isArray(raw)) return raw as Array<{ id: string }>;
        if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
          return (raw as { data: Array<{ id: string }> }).data;
        }
        return [];
      },
    );
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// Helpdesk — register a helpdesk user and create at least one ticket.
// Helpdesk has its own auth system separate from B3 (its own users table,
// sessions, etc.). Public registration is often disabled via
// platform_settings.public_signup_disabled.  We temporarily enable it via
// the B3 superuser endpoint, register the user, seed a ticket, then restore
// the original setting.
// ---------------------------------------------------------------------------
setup('seed e2e helpdesk user + ticket', async ({ baseURL }) => {
  const { api: b3Api, dispose: disposeB3 } = await makeAdminApi(baseURL!, '/b3/api');

  // 1. Read current platform signup setting
  let wasDisabled = false;
  try {
    const raw = await b3Api.get<Record<string, unknown>>('/superuser/platform-settings');
    wasDisabled = (raw as any)?.public_signup_disabled === true
      || (raw as any)?.data?.public_signup_disabled === true;
  } catch {
    // SuperUser endpoint may not be reachable; proceed optimistically.
  }

  // 2. Temporarily enable public signup if it was disabled
  if (wasDisabled) {
    try {
      await b3Api.patch('/superuser/platform-settings', { public_signup_disabled: false });
      console.log('[seed] helpdesk: temporarily enabled public signup.');
    } catch (err) {
      console.warn('[seed] helpdesk: could not enable signup —', err instanceof ApiClientError ? `${err.status}` : String(err));
    }
  }

  // 3. Register a helpdesk user (idempotent: login first, register only on failure)
  const email = 'e2e-helpdesk@bigbluebam.test';
  const password = 'E2eHelpdesk!Pass123';
  const displayName = 'E2E Helpdesk User';
  // nginx proxies /helpdesk/api/* → helpdesk-api:4001/helpdesk/*
  // So /helpdesk/api/auth/login → helpdesk-api:4001/helpdesk/auth/login
  // which matches the route definition at /helpdesk/auth/login.
  const helpdeskBase = (baseURL ?? 'http://localhost') + '/helpdesk/api';

  const helpdeskCtx = await playwrightRequest.newContext({ baseURL: helpdeskBase });
  let helpdeskSessionOk = false;
  try {
    const loginRes = await helpdeskCtx.post('/auth/login', {
      data: { email, password },
      headers: { 'Content-Type': 'application/json' },
      failOnStatusCode: false,
    });
    if (loginRes.ok()) {
      helpdeskSessionOk = true;
      console.log('[seed] helpdesk: user logged in successfully.');
    } else {
      const regRes = await helpdeskCtx.post('/auth/register', {
        data: { email, display_name: displayName, password },
        headers: { 'Content-Type': 'application/json' },
        failOnStatusCode: false,
      });
      if (regRes.ok()) {
        helpdeskSessionOk = true;
        console.log('[seed] helpdesk: user registered successfully.');
      } else {
        const body = await regRes.json().catch(() => null);
        console.warn(`[seed] helpdesk: register failed (${regRes.status()}) —`, body?.error?.message ?? 'unknown');
      }
    }

    // 4. Create a ticket if session OK and none exist
    // nginx proxies /helpdesk/api/tickets → helpdesk-api:4001/helpdesk/tickets
    // which matches the route /helpdesk/tickets.
    if (helpdeskSessionOk) {
      const ticketListRes = await helpdeskCtx.get('/tickets', { failOnStatusCode: false });
      let hasTickets = false;
      if (ticketListRes.ok()) {
        const body = await ticketListRes.json().catch(() => null);
        const list = body?.data ?? body;
        hasTickets = Array.isArray(list) && list.length > 0;
      }
      if (!hasTickets) {
        const createRes = await helpdeskCtx.post('/tickets', {
          data: {
            subject: 'E2E Seed Ticket',
            description: 'Created by e2e auth setup for helpdesk tests.',
          },
          headers: { 'Content-Type': 'application/json' },
          failOnStatusCode: false,
        });
        if (createRes.ok()) {
          console.log('[seed] helpdesk: seeded ticket.');
        } else {
          console.warn(`[seed] helpdesk: ticket create failed (${createRes.status()}).`);
        }
      } else {
        console.log('[seed] helpdesk: ticket(s) already exist.');
      }
    }
  } finally {
    await helpdeskCtx.dispose();
  }

  // 5. Restore public signup setting if we changed it
  if (wasDisabled) {
    try {
      await b3Api.patch('/superuser/platform-settings', { public_signup_disabled: true });
      console.log('[seed] helpdesk: restored public signup disabled.');
    } catch {}
  }

  await disposeB3();
});
