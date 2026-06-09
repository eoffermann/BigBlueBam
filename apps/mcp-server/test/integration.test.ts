import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from '../src/middleware/api-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const logger = pino({ level: 'silent' });

// ---- Helpers ----

function mockApiOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

function mockApiError(status: number, data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => data,
  });
}

// We test tools by directly importing and calling register functions,
// capturing the tool handlers via a mock McpServer.
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: ToolHandler;
}

function createMockServer(): { server: McpServer; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();

  const server = {
    tool: (name: string, description: string, schema: unknown, handler: ToolHandler) => {
      tools.set(name, { name, description, schema, handler });
    },
  } as unknown as McpServer;

  return { server, tools };
}

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const UUID2 = '660e8400-e29b-41d4-a716-446655440001';

// ---- Import all register functions ----
import { registerProjectTools } from '../src/tools/project-tools.js';
import { registerBoardTools } from '../src/tools/board-tools.js';
import { registerTaskTools } from '../src/tools/task-tools.js';
import { registerSprintTools } from '../src/tools/sprint-tools.js';
import { registerCommentTools } from '../src/tools/comment-tools.js';
import { registerMemberTools } from '../src/tools/member-tools.js';
import { registerReportTools } from '../src/tools/report-tools.js';
import { registerTemplateTools } from '../src/tools/template-tools.js';
import { registerImportTools } from '../src/tools/import-tools.js';
import { registerMeTools } from '../src/tools/me-tools.js';
import { registerPlatformTools } from '../src/tools/platform-tools.js';
import { registerBeaconTools } from '../src/tools/beacon-tools.js';
import { registerBamResolverTools } from '../src/tools/bam-resolver-tools.js';
import { registerAgentTools } from '../src/tools/agent-tools.js';
import { registerProposalTools } from '../src/tools/proposal-tools.js';
import { registerVisibilityTools } from '../src/tools/visibility-tools.js';
import { registerSearchTools } from '../src/tools/search-tools.js';
import { registerResolveTools } from '../src/tools/resolve-tools.js';
import { registerActivityTools } from '../src/tools/activity-tools.js';
import { registerCompositeTools } from '../src/tools/composite-tools.js';
// §16 Wave 4 entity links
import { registerEntityLinksTools } from '../src/tools/entity-links-tools.js';
// §17 Wave 4 attachments
import { registerAttachmentTools } from '../src/tools/attachment-tools.js';
// §13 Wave 4 scheduled banter
import { registerBanterTools } from '../src/tools/banter-tools.js';
// §15 Wave 5 agent policies
import { registerAgentPolicyTools } from '../src/tools/agent-policy-tools.js';
// §20 Wave 5 webhooks
import { registerAgentWebhookTools } from '../src/tools/agent-webhook-tools.js';
// §12 Wave 5 bolt observability
import { registerBoltObservabilityTools } from '../src/tools/bolt-observability-tools.js';
// §18 + §19 Wave 5 misc
import { registerIngestFingerprintTools } from '../src/tools/ingest-fingerprint-tools.js';
import type { FingerprintStore } from '../src/lib/fingerprint-store.js';
// §7 Wave 5 dedupe
import { registerDedupeTools } from '../src/tools/dedupe-tools.js';
// §4 + §8 Wave 5 trends/expertise
import { registerPhraseCountTools } from '../src/tools/phrase-count-tools.js';
import { registerExpertiseTools } from '../src/tools/expertise-tools.js';
// §1 Wave 5 banter subs
import { registerBanterSubscriptionTools } from '../src/tools/banter-subscription-tools.js';
// Cleanup pass: register every peer-app tool suite so the integration
// test's tools.size === expectedTools.length invariant catches drift
// across the full MCP surface, not just the Bam core.
import { registerUserResolverTools } from '../src/tools/user-resolver-tools.js';
import { registerHelpdeskTools } from '../src/tools/helpdesk-tools.js';
import { registerBriefTools } from '../src/tools/brief-tools.js';
import { registerBoltTools } from '../src/tools/bolt-tools.js';
import { registerBearingTools } from '../src/tools/bearing-tools.js';
import { registerBondTools } from '../src/tools/bond-tools.js';
import { registerBlastTools } from '../src/tools/blast-tools.js';
import { registerBookTools } from '../src/tools/book-tools.js';
import { registerBenchTools } from '../src/tools/bench-tools.js';
import { registerBillTools } from '../src/tools/bill-tools.js';
import { registerBlankTools } from '../src/tools/blank-tools.js';
import { registerBlueprintTools } from '../src/tools/blueprint-tools.js';

describe('MCP Integration Tests', () => {
  let api: ApiClient;
  let tools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new ApiClient('http://localhost:4000', 'test-token', logger);
    const mock = createMockServer();
    tools = mock.tools;

    registerProjectTools(mock.server, api);
    registerBoardTools(mock.server, api, 'http://localhost:4008');
    registerTaskTools(mock.server, api);
    registerSprintTools(mock.server, api);
    registerCommentTools(mock.server, api);
    registerMemberTools(mock.server, api);
    registerReportTools(mock.server, api);
    registerTemplateTools(mock.server, api);
    registerImportTools(mock.server, api);
    registerMeTools(mock.server, api);
    registerPlatformTools(mock.server, api);
    registerBeaconTools(mock.server, api, 'http://localhost:4004');
    registerBamResolverTools(mock.server, api);
    registerAgentTools(mock.server, api);
    registerProposalTools(mock.server, api);
    registerVisibilityTools(mock.server, api);
    registerSearchTools(mock.server, api, {
      apiUrl: 'http://localhost:4000',
      helpdeskApiUrl: 'http://localhost:4001',
      bondApiUrl: 'http://localhost:4009',
      briefApiUrl: 'http://localhost:4005',
      beaconApiUrl: 'http://localhost:4004',
      banterApiUrl: 'http://localhost:4002',
      boardApiUrl: 'http://localhost:4008',
    });
    registerResolveTools(mock.server, api, {
      bondApiUrl: 'http://localhost:4009',
      briefApiUrl: 'http://localhost:4005',
      helpdeskApiUrl: 'http://localhost:4001',
    });
    registerActivityTools(mock.server, api);
    registerCompositeTools(mock.server, api, {
      apiUrl: 'http://localhost:4000',
      bondApiUrl: 'http://localhost:4009',
      helpdeskApiUrl: 'http://localhost:4001',
      billApiUrl: 'http://localhost:4014',
      bearingApiUrl: 'http://localhost:4007',
      briefApiUrl: 'http://localhost:4005',
      beaconApiUrl: 'http://localhost:4004',
    });
    // §16 Wave 4 entity links
    registerEntityLinksTools(mock.server, api);
    // §17 Wave 4 attachments
    registerAttachmentTools(mock.server, api);
    // §13 Wave 4 scheduled banter — registers the full banter suite so
    // tests covering banter_post_message / banter_schedule_post can exercise
    // the handlers. Every banter_* tool name is listed in expectedTools below.
    registerBanterTools(mock.server, api, 'http://localhost:4002');
    // §15 Wave 5 agent policies
    registerAgentPolicyTools(mock.server, api);
    // §20 Wave 5 webhooks
    registerAgentWebhookTools(mock.server, api);
    // §12 Wave 5 bolt observability
    registerBoltObservabilityTools(mock.server, api, 'http://localhost:4006');
    // §18 + §19 Wave 5 misc: ingest fingerprint tool uses an injected
    // FingerprintStore so the harness doesn't need a real Redis. This stub
    // returns first_seen: true on every call; dedicated tests exercise the
    // full SET NX EX surface.
    const stubFingerprintStore: FingerprintStore = {
      checkAndSet: async (_org, _src, _fp, window) => ({
        first_seen: true,
        window_seconds: window,
      }),
      close: async () => {},
    };
    registerIngestFingerprintTools(mock.server, api, stubFingerprintStore);
    // §7 Wave 5 dedupe: dedupe_record_decision and dedupe_list_pending run
    // against the main api client; bond_find_duplicates and
    // helpdesk_find_similar_tickets hit the per-app services via fetch.
    registerDedupeTools(mock.server, api, {
      bondApiUrl: 'http://localhost:4009',
      helpdeskApiUrl: 'http://localhost:4001',
    });
    // §4 + §8 Wave 5 trends/expertise
    registerPhraseCountTools(mock.server, api, {
      helpdeskApiUrl: 'http://localhost:4001',
      apiUrl: 'http://localhost:4000',
    });
    registerExpertiseTools(mock.server, api);
    // §1 Wave 5 banter subs
    registerBanterSubscriptionTools(mock.server, api, 'http://localhost:4002');
    // Peer-app tool suites. These were previously not wired into the harness
    // so their tool names were missing from expectedTools and drift went
    // undetected. All tool names from these suites are in the expectedTools
    // allowlist below.
    registerUserResolverTools(mock.server, api);
    registerHelpdeskTools(mock.server, api, 'http://localhost:4001');
    registerBriefTools(mock.server, api, 'http://localhost:4005');
    registerBoltTools(mock.server, api, 'http://localhost:4006');
    registerBearingTools(mock.server, api, 'http://localhost:4007');
    registerBondTools(mock.server, api, 'http://localhost:4009');
    registerBlastTools(mock.server, api, 'http://localhost:4010');
    registerBookTools(mock.server, api, 'http://localhost:4012');
    registerBenchTools(mock.server, api, 'http://localhost:4011');
    registerBillTools(mock.server, api, 'http://localhost:4014');
    registerBlankTools(mock.server, api, 'http://localhost:4013');
    registerBlueprintTools(mock.server, api, 'http://localhost:4015');
  });

  function getTool(name: string): RegisteredTool {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not registered`);
    return tool;
  }

  function expectSuccessFormat(result: { content: { type: string; text: string }[]; isError?: boolean }) {
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.isError).toBeUndefined();
    // Text should be valid JSON
    expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
  }

  function expectErrorFormat(result: { content: { type: string; text: string }[]; isError?: boolean }) {
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Error');
  }

  // ===== PROJECT TOOLS =====

  describe('list_projects', () => {
    it('returns projects on success', async () => {
      mockApiOk({ data: [{ id: UUID, name: 'Test' }], meta: {} });
      const result = await getTool('list_projects').handler({});
      expectSuccessFormat(result);
      expect(JSON.parse(result.content[0]!.text).data).toHaveLength(1);
    });

    it('returns error on failure', async () => {
      mockApiError(500, { error: 'Server error' });
      const result = await getTool('list_projects').handler({});
      expectErrorFormat(result);
    });
  });

  describe('get_project', () => {
    it('returns project details on success', async () => {
      mockApiOk({ id: UUID, name: 'My Project' });
      const result = await getTool('get_project').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error for not found', async () => {
      mockApiError(404, { error: 'Not found' });
      const result = await getTool('get_project').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('create_project', () => {
    it('creates a project on success', async () => {
      mockApiOk({ id: UUID, name: 'New', task_id_prefix: 'NEW' });
      const result = await getTool('create_project').handler({
        name: 'New', task_id_prefix: 'NEW',
      });
      expectSuccessFormat(result);
    });

    it('returns error on validation failure', async () => {
      mockApiError(400, { error: 'Validation error' });
      const result = await getTool('create_project').handler({ name: '', task_id_prefix: '' });
      expectErrorFormat(result);
    });
  });

  describe('test_slack_webhook', () => {
    it('posts to the correct path on success', async () => {
      mockApiOk({ message: 'Test message sent' });
      const result = await getTool('test_slack_webhook').handler({ project_id: UUID });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/projects/${UUID}/slack-integration/test`);
      expect(call[1].method).toBe('POST');
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'No Slack webhook configured' });
      const result = await getTool('test_slack_webhook').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('disconnect_github_integration', () => {
    it('returns error when confirm is false', async () => {
      const result = await getTool('disconnect_github_integration').handler({
        project_id: UUID, confirm: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('confirm=true');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls api.delete when confirm is true', async () => {
      mockApiOk({ deleted: true });
      const result = await getTool('disconnect_github_integration').handler({
        project_id: UUID, confirm: true,
      });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/projects/${UUID}/github-integration`);
      expect(call[1].method).toBe('DELETE');
    });

    it('returns error on API failure with confirm', async () => {
      mockApiError(404, { error: 'No GitHub integration found' });
      const result = await getTool('disconnect_github_integration').handler({
        project_id: UUID, confirm: true,
      });
      expectErrorFormat(result);
    });
  });

  // ===== BAM RESOLVER TOOLS =====
  // The legacy `get_board` / `list_phases` / `create_phase` / `reorder_phases`
  // tools were dropped when board-tools.ts was repurposed for the whiteboard
  // collaboration product (commit d8bfb26). The phase listing surface now
  // lives in bam-resolver-tools.ts as `bam_list_phases`. Phase write
  // operations have no MCP wrapper today — callers go through the REST API
  // directly.

  describe('bam_list_phases', () => {
    it('returns phases on success', async () => {
      mockApiOk({ data: [{ id: UUID, name: 'To Do', position: 0 }] });
      const result = await getTool('bam_list_phases').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(500, { error: 'Internal error' });
      const result = await getTool('bam_list_phases').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  // ===== TASK TOOLS =====

  describe('search_tasks', () => {
    it('returns matching tasks on success', async () => {
      mockApiOk({ data: [{ id: UUID, title: 'Task 1' }], meta: {} });
      const result = await getTool('search_tasks').handler({
        project_id: UUID, q: 'login',
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(500, { error: 'DB error' });
      const result = await getTool('search_tasks').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('get_task', () => {
    it('returns task details on success', async () => {
      mockApiOk({ id: UUID, title: 'Test Task', human_id: 'TST-1' });
      const result = await getTool('get_task').handler({ task_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error for not found', async () => {
      mockApiError(404, { error: 'Task not found' });
      const result = await getTool('get_task').handler({ task_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('create_task', () => {
    it('creates a task on success', async () => {
      mockApiOk({ id: UUID, title: 'New Task', human_id: 'TST-1' });
      const result = await getTool('create_task').handler({
        project_id: UUID, title: 'New Task', phase_id: UUID2,
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Missing title' });
      const result = await getTool('create_task').handler({
        project_id: UUID, title: '', phase_id: UUID2,
      });
      expectErrorFormat(result);
    });
  });

  describe('update_task', () => {
    it('updates task on success', async () => {
      mockApiOk({ id: UUID, title: 'Updated' });
      const result = await getTool('update_task').handler({
        task_id: UUID, title: 'Updated',
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Task not found' });
      const result = await getTool('update_task').handler({
        task_id: UUID, title: 'x',
      });
      expectErrorFormat(result);
    });
  });

  describe('move_task', () => {
    it('moves task on success', async () => {
      mockApiOk({ id: UUID, phase_id: UUID2, position: 0 });
      const result = await getTool('move_task').handler({
        task_id: UUID, phase_id: UUID2, position: 0,
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid phase' });
      const result = await getTool('move_task').handler({
        task_id: UUID, phase_id: UUID2, position: 0,
      });
      expectErrorFormat(result);
    });
  });

  describe('delete_task', () => {
    it('asks for confirmation when confirm is false', async () => {
      const result = await getTool('delete_task').handler({
        task_id: UUID, confirm: false,
      });
      expect(result.content[0]!.text).toContain('confirm');
      expect(result.isError).toBeUndefined();
    });

    it('deletes task when confirmed', async () => {
      mockApiOk({});
      const result = await getTool('delete_task').handler({
        task_id: UUID, confirm: true,
      });
      expect(result.content[0]!.text).toContain('deleted successfully');
    });

    it('returns error on API failure with confirm', async () => {
      mockApiError(404, { error: 'Not found' });
      const result = await getTool('delete_task').handler({
        task_id: UUID, confirm: true,
      });
      expectErrorFormat(result);
    });
  });

  describe('bulk_update_tasks', () => {
    it('bulk updates tasks on success', async () => {
      mockApiOk({ results: [{ task_id: UUID, success: true }] });
      const result = await getTool('bulk_update_tasks').handler({
        task_ids: [UUID], operation: 'update', fields: { priority: 'high' },
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid operation' });
      const result = await getTool('bulk_update_tasks').handler({
        task_ids: [UUID], operation: 'update', fields: {},
      });
      expectErrorFormat(result);
    });
  });

  describe('log_time', () => {
    it('logs time on success', async () => {
      mockApiOk({ id: UUID, minutes: 60 });
      const result = await getTool('log_time').handler({
        task_id: UUID, minutes: 60, date: '2025-01-15',
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid minutes' });
      const result = await getTool('log_time').handler({
        task_id: UUID, minutes: -1, date: '2025-01-15',
      });
      expectErrorFormat(result);
    });
  });

  describe('duplicate_task', () => {
    it('duplicates task on success', async () => {
      mockApiOk({ id: UUID2, title: 'Test Task (copy)', human_id: 'TST-2' });
      const result = await getTool('duplicate_task').handler({ task_id: UUID });
      expectSuccessFormat(result);
      const data = JSON.parse(result.content[0]!.text);
      expect(data.human_id).toBe('TST-2');
    });

    it('duplicates with subtasks', async () => {
      mockApiOk({ id: UUID2, title: 'Test Task (copy)', subtask_count: 3 });
      const result = await getTool('duplicate_task').handler({
        task_id: UUID, include_subtasks: true,
      });
      expectSuccessFormat(result);
    });

    it('returns error for invalid task', async () => {
      mockApiError(404, { error: 'Task not found' });
      const result = await getTool('duplicate_task').handler({ task_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('import_csv', () => {
    it('imports CSV rows on success', async () => {
      mockApiOk({ imported: 3, errors: [] });
      const result = await getTool('import_csv').handler({
        project_id: UUID,
        rows: [
          { Title: 'Task 1', Priority: 'high' },
          { Title: 'Task 2', Priority: 'low' },
          { Title: 'Task 3', Priority: 'medium' },
        ],
        mapping: { Title: 'title', Priority: 'priority' },
      });
      expectSuccessFormat(result);
      expect(JSON.parse(result.content[0]!.text).imported).toBe(3);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid mapping' });
      const result = await getTool('import_csv').handler({
        project_id: UUID, rows: [], mapping: {},
      });
      expectErrorFormat(result);
    });
  });

  // ===== SPRINT TOOLS =====

  describe('list_sprints', () => {
    it('returns sprints on success', async () => {
      mockApiOk({ data: [{ id: UUID, name: 'Sprint 1' }] });
      const result = await getTool('list_sprints').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(500, { error: 'Error' });
      const result = await getTool('list_sprints').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('create_sprint', () => {
    it('creates sprint on success', async () => {
      mockApiOk({ id: UUID, name: 'Sprint 1' });
      const result = await getTool('create_sprint').handler({
        project_id: UUID, name: 'Sprint 1',
        start_date: '2025-01-01', end_date: '2025-01-14',
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid dates' });
      const result = await getTool('create_sprint').handler({
        project_id: UUID, name: '', start_date: '', end_date: '',
      });
      expectErrorFormat(result);
    });
  });

  describe('start_sprint', () => {
    it('starts sprint on success', async () => {
      mockApiOk({ id: UUID, status: 'active' });
      const result = await getTool('start_sprint').handler({ sprint_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(409, { error: 'Already active' });
      const result = await getTool('start_sprint').handler({ sprint_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('complete_sprint', () => {
    it('completes sprint on success', async () => {
      mockApiOk({ id: UUID, status: 'completed' });
      const result = await getTool('complete_sprint').handler({
        sprint_id: UUID,
        carry_forward: {
          target_sprint_id: UUID2,
          tasks: [{ task_id: UUID, action: 'carry_forward' }],
        },
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Sprint not active' });
      const result = await getTool('complete_sprint').handler({
        sprint_id: UUID,
        carry_forward: { target_sprint_id: UUID2, tasks: [] },
      });
      expectErrorFormat(result);
    });
  });

  describe('get_sprint_report', () => {
    it('returns report on success', async () => {
      mockApiOk({ velocity: 42, burndown: [] });
      const result = await getTool('get_sprint_report').handler({ sprint_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Sprint not found' });
      const result = await getTool('get_sprint_report').handler({ sprint_id: UUID });
      expectErrorFormat(result);
    });
  });

  // ===== COMMENT TOOLS =====

  describe('list_comments', () => {
    it('returns comments on success', async () => {
      mockApiOk({ data: [{ id: UUID, body: 'Great work!' }] });
      const result = await getTool('list_comments').handler({ task_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Task not found' });
      const result = await getTool('list_comments').handler({ task_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('add_comment', () => {
    it('adds comment on success', async () => {
      mockApiOk({ id: UUID, body: 'New comment' });
      const result = await getTool('add_comment').handler({
        task_id: UUID, body: 'New comment',
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Empty body' });
      const result = await getTool('add_comment').handler({
        task_id: UUID, body: '',
      });
      expectErrorFormat(result);
    });
  });

  // ===== MEMBER TOOLS =====

  describe('list_members', () => {
    it('returns project members on success', async () => {
      mockApiOk({ data: [{ id: UUID, name: 'Alice' }] });
      const result = await getTool('list_members').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns org members when no project_id', async () => {
      mockApiOk({ data: [{ id: UUID, name: 'Bob' }] });
      const result = await getTool('list_members').handler({});
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(403, { error: 'Forbidden' });
      const result = await getTool('list_members').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('get_my_tasks', () => {
    it('returns tasks for current user with project_id', async () => {
      // First call: /auth/me
      mockApiOk({ id: UUID });
      // Second call: /projects/:id/tasks
      mockApiOk({ data: [{ id: UUID2, title: 'My Task' }] });
      const result = await getTool('get_my_tasks').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns tasks for current user without project_id', async () => {
      mockApiOk({ id: UUID });
      mockApiOk({ data: [{ id: UUID2, title: 'My Task' }] });
      const result = await getTool('get_my_tasks').handler({});
      expectSuccessFormat(result);
    });

    it('returns error when auth fails', async () => {
      mockApiError(401, { error: 'Unauthorized' });
      const result = await getTool('get_my_tasks').handler({});
      expectErrorFormat(result);
    });
  });

  // ===== REPORT TOOLS =====

  describe('get_velocity_report', () => {
    it('returns velocity data on success', async () => {
      mockApiOk({ sprints: [{ name: 'Sprint 1', velocity: 21 }] });
      const result = await getTool('get_velocity_report').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Project not found' });
      const result = await getTool('get_velocity_report').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('get_burndown', () => {
    it('returns burndown data on success', async () => {
      mockApiOk({ days: [{ date: '2025-01-01', remaining: 42 }] });
      const result = await getTool('get_burndown').handler({ sprint_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Sprint not found' });
      const result = await getTool('get_burndown').handler({ sprint_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('get_cumulative_flow', () => {
    it('returns CFD data on success', async () => {
      mockApiOk({ data: [{ date: '2025-01-01', todo: 10, done: 5 }] });
      const result = await getTool('get_cumulative_flow').handler({
        project_id: UUID, from_date: '2025-01-01', to_date: '2025-01-31',
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid date range' });
      const result = await getTool('get_cumulative_flow').handler({
        project_id: UUID, from_date: '', to_date: '',
      });
      expectErrorFormat(result);
    });
  });

  describe('get_overdue_tasks', () => {
    it('returns overdue tasks on success', async () => {
      mockApiOk({ tasks: [{ id: UUID, title: 'Overdue Task', due_date: '2024-12-01' }] });
      const result = await getTool('get_overdue_tasks').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Project not found' });
      const result = await getTool('get_overdue_tasks').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('get_workload', () => {
    it('returns workload data on success', async () => {
      mockApiOk({
        members: [
          { user_id: UUID, name: 'Alice', task_count: 5, story_points: 21 },
          { user_id: UUID2, name: 'Bob', task_count: 3, story_points: 13 },
        ],
      });
      const result = await getTool('get_workload').handler({ project_id: UUID });
      expectSuccessFormat(result);
      const data = JSON.parse(result.content[0]!.text);
      expect(data.members).toHaveLength(2);
    });

    it('returns error on failure', async () => {
      mockApiError(500, { error: 'Internal error' });
      const result = await getTool('get_workload').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('get_status_distribution', () => {
    it('returns status distribution on success', async () => {
      mockApiOk({
        distribution: [
          { phase: 'To Do', count: 10 },
          { phase: 'Done', count: 5 },
        ],
      });
      const result = await getTool('get_status_distribution').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Project not found' });
      const result = await getTool('get_status_distribution').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  // ===== TEMPLATE TOOLS =====

  describe('list_templates', () => {
    it('returns templates on success', async () => {
      mockApiOk({ data: [{ id: UUID, name: 'Bug Report Template' }] });
      const result = await getTool('list_templates').handler({ project_id: UUID });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Project not found' });
      const result = await getTool('list_templates').handler({ project_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('create_from_template', () => {
    it('creates task from template on success', async () => {
      mockApiOk({ id: UUID2, title: 'Bug Report', human_id: 'TST-10' });
      const result = await getTool('create_from_template').handler({
        project_id: UUID, template_id: UUID2,
      });
      expectSuccessFormat(result);
    });

    it('creates with overrides', async () => {
      mockApiOk({ id: UUID2, title: 'Custom Bug', priority: 'critical' });
      const result = await getTool('create_from_template').handler({
        project_id: UUID, template_id: UUID2,
        overrides: { title: 'Custom Bug', priority: 'critical' },
      });
      expectSuccessFormat(result);
    });

    it('returns error for invalid template', async () => {
      mockApiError(404, { error: 'Template not found' });
      const result = await getTool('create_from_template').handler({
        project_id: UUID, template_id: UUID2,
      });
      expectErrorFormat(result);
    });
  });

  // ===== IMPORT TOOLS =====

  describe('import_github_issues', () => {
    it('imports issues on success', async () => {
      mockApiOk({ imported: 2, skipped: 0 });
      const result = await getTool('import_github_issues').handler({
        project_id: UUID,
        issues: [
          { number: 1, title: 'Fix login bug', body: 'Details here', state: 'open', labels: ['bug'], assignee: 'alice' },
          { number: 2, title: 'Add feature', body: null, state: 'open', labels: [], assignee: null },
        ],
      });
      expectSuccessFormat(result);
      expect(JSON.parse(result.content[0]!.text).imported).toBe(2);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Invalid issues format' });
      const result = await getTool('import_github_issues').handler({
        project_id: UUID, issues: [],
      });
      expectErrorFormat(result);
    });
  });

  describe('suggest_branch_name', () => {
    it('generates branch name from task', async () => {
      mockApiOk({ human_id: 'FRND-42', title: 'Design Login Screen' });
      const result = await getTool('suggest_branch_name').handler({ task_id: UUID });
      expectSuccessFormat(result);
      const data = JSON.parse(result.content[0]!.text);
      expect(data.branch_name).toBe('feature/FRND-42-design-login-screen');
      expect(data.human_id).toBe('FRND-42');
    });

    it('handles special characters in title', async () => {
      mockApiOk({ human_id: 'TST-1', title: 'Fix: bug & crash!!! (urgent)' });
      const result = await getTool('suggest_branch_name').handler({ task_id: UUID });
      expectSuccessFormat(result);
      const data = JSON.parse(result.content[0]!.text);
      expect(data.branch_name).toBe('feature/TST-1-fix-bug-crash-urgent');
    });

    it('returns error when task not found', async () => {
      mockApiError(404, { error: 'Task not found' });
      const result = await getTool('suggest_branch_name').handler({ task_id: UUID });
      expectErrorFormat(result);
    });
  });

  // ===== ME TOOLS =====

  describe('me tools', () => {
    it('get_me hits /auth/me', async () => {
      mockApiOk({ data: { id: UUID, email: 'x@y.com', is_superuser: false } });
      const result = await getTool('get_me').handler({});
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/auth/me');
      expect(call[1].method).toBe('GET');
    });

    it('update_me PATCHes /auth/me with body', async () => {
      mockApiOk({ data: { id: UUID, display_name: 'Ada' } });
      const result = await getTool('update_me').handler({ display_name: 'Ada' });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/auth/me');
      expect(call[1].method).toBe('PATCH');
      expect(JSON.parse(call[1].body as string)).toEqual({ display_name: 'Ada' });
    });

    it('list_my_notifications forwards query params', async () => {
      mockApiOk({ data: [] });
      await getTool('list_my_notifications').handler({ unread_only: true, limit: 20 });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/me/notifications');
      expect(call[0]).toContain('unread_only=true');
      expect(call[0]).toContain('limit=20');
    });

    it('mark_notification_read POSTs to per-id endpoint', async () => {
      mockApiOk({ data: { ok: true } });
      await getTool('mark_notification_read').handler({ notification_id: UUID });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/me/notifications/${UUID}/read`);
      expect(call[1].method).toBe('POST');
    });

    it('switch_active_org posts to /auth/switch-org', async () => {
      mockApiOk({ data: { org_id: UUID } });
      await getTool('switch_active_org').handler({ org_id: UUID });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/auth/switch-org');
      expect(JSON.parse(call[1].body as string)).toEqual({ org_id: UUID });
    });
  });

  // ===== PLATFORM TOOLS =====

  describe('platform tools', () => {
    it('get_platform_settings hits /superuser/platform-settings', async () => {
      mockApiOk({ data: { public_signup_disabled: false } });
      await getTool('get_platform_settings').handler({});
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/superuser/platform-settings');
      expect(call[1].method).toBe('GET');
    });

    it('set_public_signup_disabled PATCHes with payload', async () => {
      mockApiOk({ data: { public_signup_disabled: true } });
      await getTool('set_public_signup_disabled').handler({ public_signup_disabled: true });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/superuser/platform-settings');
      expect(call[1].method).toBe('PATCH');
      expect(JSON.parse(call[1].body as string)).toEqual({ public_signup_disabled: true });
    });

    it('get_public_config gates to SuperUser via /auth/me check', async () => {
      // First call: /auth/me returns non-SuperUser
      mockApiOk({ data: { id: UUID, is_superuser: false } });
      const result = await getTool('get_public_config').handler({});
      expectErrorFormat(result);
      expect(result.content[0]!.text).toContain('SuperUser');
      // Only /auth/me should have been called (not /public/config)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toContain('/auth/me');
    });

    it('get_public_config proxies when caller is SuperUser', async () => {
      mockApiOk({ data: { id: UUID, is_superuser: true } });
      mockApiOk({ data: { public_signup_disabled: false } });
      const result = await getTool('get_public_config').handler({});
      expectSuccessFormat(result);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![0]).toContain('/public/config');
    });

    it('submit_beta_signup rejects non-SuperUsers', async () => {
      mockApiOk({ data: { id: UUID, is_superuser: false } });
      const result = await getTool('submit_beta_signup').handler({
        name: 'Ada', email: 'a@b.com',
      });
      expectErrorFormat(result);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('submit_beta_signup forwards body when SuperUser', async () => {
      mockApiOk({ data: { id: UUID, is_superuser: true } });
      mockApiOk({ data: { ok: true } });
      await getTool('submit_beta_signup').handler({
        name: 'Ada', email: 'a@b.com', phone: '555',
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const call = mockFetch.mock.calls[1]!;
      expect(call[0]).toContain('/public/beta-signup');
      expect(JSON.parse(call[1].body as string)).toMatchObject({
        name: 'Ada', email: 'a@b.com', phone: '555',
      });
    });
  });

  // ===== AGENT TOOLS (AGENTIC_TODO §10) =====

  describe('agent tools', () => {
    it('agent_heartbeat POSTs to /v1/agents/heartbeat with merged payload', async () => {
      mockApiOk({
        data: {
          id: UUID,
          org_id: UUID2,
          user_id: UUID,
          name: 'intake-worker',
          version: '1.0.0',
          capabilities: ['helpdesk.triage'],
          last_heartbeat_at: new Date().toISOString(),
          first_seen_at: new Date().toISOString(),
        },
      });
      const result = await getTool('agent_heartbeat').handler({
        runner_name: 'intake-worker',
        version: '1.0.0',
        capabilities: ['helpdesk.triage'],
      });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/v1/agents/heartbeat');
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body as string);
      expect(body.runner_name).toBe('intake-worker');
      expect(body.version).toBe('1.0.0');
      expect(body.capabilities).toEqual(['helpdesk.triage']);
    });

    it('agent_heartbeat surfaces 403 NOT_A_SERVICE_ACCOUNT as error', async () => {
      mockApiError(403, {
        error: {
          code: 'NOT_A_SERVICE_ACCOUNT',
          message: 'This endpoint requires a service-account caller',
        },
      });
      const result = await getTool('agent_heartbeat').handler({ runner_name: 'x' });
      expectErrorFormat(result);
      expect(result.content[0]!.text).toContain('NOT_A_SERVICE_ACCOUNT');
    });

    it('agent_audit builds a query string from since/limit/cursor', async () => {
      mockApiOk({
        data: [
          {
            id: UUID,
            project_id: UUID2,
            actor_id: UUID,
            actor_type: 'service',
            action: 'task.create',
            created_at: new Date().toISOString(),
          },
        ],
        meta: { next_cursor: null, has_more: false },
      });
      const result = await getTool('agent_audit').handler({
        agent_user_id: UUID,
        since: '2026-04-01T00:00:00Z',
        limit: 10,
      });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/v1/agents/${UUID}/audit`);
      expect(call[0]).toContain('since=2026-04-01T00');
      expect(call[0]).toContain('limit=10');
      expect(call[1].method).toBe('GET');
    });

    it('agent_audit omits query string when only agent_user_id is given', async () => {
      mockApiOk({ data: [], meta: { next_cursor: null, has_more: false } });
      await getTool('agent_audit').handler({ agent_user_id: UUID });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toMatch(new RegExp(`/v1/agents/${UUID}/audit$`));
    });

    it('agent_self_report requires project_id (enforced at the API layer)', async () => {
      // Simulate the 400 PROJECT_ID_REQUIRED the server returns.
      mockApiError(400, {
        error: {
          code: 'PROJECT_ID_REQUIRED',
          message: 'project_id is required for agent self-report',
        },
      });
      const result = await getTool('agent_self_report').handler({
        summary: 'done',
        project_id: UUID,
      });
      expectErrorFormat(result);
      expect(result.content[0]!.text).toContain('PROJECT_ID_REQUIRED');
    });

    it('agent_self_report posts summary + metrics when provided', async () => {
      mockApiOk({
        data: {
          id: UUID,
          project_id: UUID2,
          actor_id: UUID,
          actor_type: 'service',
          action: 'agent.self_report',
          details: { summary: 'done', metrics: { count: 3 } },
          created_at: new Date().toISOString(),
        },
      });
      const result = await getTool('agent_self_report').handler({
        summary: 'done',
        metrics: { count: 3 },
        project_id: UUID2,
      });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/v1/agents/self-report');
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body as string);
      expect(body.summary).toBe('done');
      expect(body.project_id).toBe(UUID2);
      expect(body.metrics).toEqual({ count: 3 });
    });
  });

  // ===== PROPOSAL TOOLS (AGENTIC_TODO §9 Wave 2) =====

  describe('proposal tools', () => {
    it('proposal_create POSTs to /v1/proposals with the full body', async () => {
      mockApiOk({
        data: {
          id: UUID,
          org_id: UUID2,
          actor_id: UUID,
          proposer_kind: 'agent',
          proposed_action: 'blast.campaign.send',
          status: 'pending',
          approver_id: UUID2,
          expires_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      });
      const result = await getTool('proposal_create').handler({
        proposed_action: 'blast.campaign.send',
        approver_id: UUID2,
        subject_type: 'blast.campaign',
        subject_id: UUID,
        ttl_seconds: 3600,
      });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/v1/proposals');
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body as string);
      expect(body.proposed_action).toBe('blast.campaign.send');
      expect(body.approver_id).toBe(UUID2);
      expect(body.ttl_seconds).toBe(3600);
    });

    it('proposal_list builds a filtered query string', async () => {
      mockApiOk({ data: [], meta: { next_cursor: null, has_more: false } });
      await getTool('proposal_list').handler({
        approver_id: UUID,
        status: 'pending',
        limit: 25,
      });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/v1/proposals');
      expect(call[0]).toContain('filter%5Bapprover_id%5D=' + UUID);
      expect(call[0]).toContain('filter%5Bstatus%5D=pending');
      expect(call[0]).toContain('limit=25');
      expect(call[1].method).toBe('GET');
    });

    it('proposal_list omits the query string when no filters are given', async () => {
      mockApiOk({ data: [], meta: { next_cursor: null, has_more: false } });
      await getTool('proposal_list').handler({});
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toMatch(/\/v1\/proposals$/);
    });

    it('proposal_decide POSTs to the decide sub-route and forwards the decision', async () => {
      mockApiOk({
        data: { id: UUID, status: 'approved', decided_at: new Date().toISOString() },
      });
      const result = await getTool('proposal_decide').handler({
        proposal_id: UUID,
        decision: 'approve',
        reason: 'looks good',
      });
      expectSuccessFormat(result);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/v1/proposals/${UUID}/decide`);
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body as string);
      expect(body.decision).toBe('approve');
      expect(body.reason).toBe('looks good');
    });

    it('proposal_decide surfaces 409 PROPOSAL_ALREADY_DECIDED as an error', async () => {
      mockApiError(409, {
        error: { code: 'PROPOSAL_ALREADY_DECIDED', message: 'Already decided' },
      });
      const result = await getTool('proposal_decide').handler({
        proposal_id: UUID,
        decision: 'approve',
      });
      expectErrorFormat(result);
      expect(result.content[0]!.text).toContain('PROPOSAL_ALREADY_DECIDED');
    });
  });

  // ===== BEACON TOOLS =====

  describe('beacon_create', () => {
    it('creates a beacon on success', async () => {
      mockApiOk({ id: UUID, title: 'Deploy Guide', status: 'Draft' });
      const result = await getTool('beacon_create').handler({
        title: 'Deploy Guide', body: '# Steps\n1. Build\n2. Deploy',
      });
      expectSuccessFormat(result);
      expect(JSON.parse(result.content[0]!.text).status).toBe('Draft');
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Validation error' });
      const result = await getTool('beacon_create').handler({ title: '', body: '' });
      expectErrorFormat(result);
    });
  });

  describe('beacon_search', () => {
    it('returns search results on success', async () => {
      mockApiOk({ results: [{ id: UUID, title: 'Deploy Guide', score: 0.95 }], total_candidates: 1 });
      const result = await getTool('beacon_search').handler({ query: 'deploy' });
      expectSuccessFormat(result);
      expect(JSON.parse(result.content[0]!.text).results).toHaveLength(1);
    });

    it('returns error on failure', async () => {
      mockApiError(500, { error: 'Search engine error' });
      const result = await getTool('beacon_search').handler({ query: 'deploy' });
      expectErrorFormat(result);
    });
  });

  describe('beacon_graph_neighbors', () => {
    it('returns graph data on success', async () => {
      mockApiOk({
        focal_beacon_id: UUID,
        nodes: [{ id: UUID, title: 'Node 1' }],
        edges: [{ source: UUID, target: UUID2, type: 'RelatedTo' }],
      });
      const result = await getTool('beacon_graph_neighbors').handler({ beacon_id: UUID });
      expectSuccessFormat(result);
      const data = JSON.parse(result.content[0]!.text);
      expect(data.nodes).toHaveLength(1);
      expect(data.edges).toHaveLength(1);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Beacon not found' });
      const result = await getTool('beacon_graph_neighbors').handler({ beacon_id: UUID });
      expectErrorFormat(result);
    });
  });

  describe('beacon_tag_add', () => {
    it('adds tags on success', async () => {
      mockApiOk({ id: UUID, tags: ['devops', 'staging'] });
      const result = await getTool('beacon_tag_add').handler({ id: UUID, tags: ['devops', 'staging'] });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(404, { error: 'Beacon not found' });
      const result = await getTool('beacon_tag_add').handler({ id: UUID, tags: ['devops'] });
      expectErrorFormat(result);
    });
  });

  describe('beacon_query_save', () => {
    it('saves a query on success', async () => {
      mockApiOk({ id: UUID, name: 'My Deploy Query' });
      const result = await getTool('beacon_query_save').handler({
        name: 'My Deploy Query',
        query_body: { query: 'deploy', filters: { tags: ['devops'] } },
      });
      expectSuccessFormat(result);
    });

    it('returns error on failure', async () => {
      mockApiError(400, { error: 'Duplicate name' });
      const result = await getTool('beacon_query_save').handler({
        name: 'Dup', query_body: {},
      });
      expectErrorFormat(result);
    });
  });

  // ===== §13 WAVE 4 SCHEDULED BANTER =====

  describe('banter_post_message (back-compat and scheduled)', () => {
    const CHANNEL_UUID = '770e8400-e29b-41d4-a716-446655440002';

    it('immediate post with only channel_id + content is unchanged', async () => {
      // No scheduled_at → hits the banter-api POST /messages path and returns
      // a normal message envelope.
      mockApiOk({ data: { id: UUID, channel_id: CHANNEL_UUID, content: 'hi', created_at: '2026-04-15T12:00:00Z', updated_at: '2026-04-15T12:00:00Z' } });
      const result = await getTool('banter_post_message').handler({
        channel_id: CHANNEL_UUID,
        content: 'hi',
      });
      expect(result.isError).toBeUndefined();
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/v1/channels/${CHANNEL_UUID}/messages`);
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body);
      // Back-compat: no scheduled_at or quiet-hours keys are sent.
      expect(body).toEqual({ content: 'hi' });
    });

    it('passes scheduled_at / defer_if_quiet through to banter-api', async () => {
      mockApiOk({
        data: {
          scheduled: true,
          scheduled_message_id: UUID,
          scheduled_at: '2026-05-01T12:00:00Z',
          defer_reason: 'scheduled',
        },
      });
      const result = await getTool('banter_post_message').handler({
        channel_id: CHANNEL_UUID,
        content: 'later',
        scheduled_at: '2026-05-01T12:00:00Z',
        defer_if_quiet: true,
      });
      expect(result.isError).toBeUndefined();
      const call = mockFetch.mock.calls[0]!;
      const body = JSON.parse(call[1].body);
      expect(body.scheduled_at).toBe('2026-05-01T12:00:00Z');
      expect(body.defer_if_quiet).toBe(true);
    });
  });

  describe('banter_schedule_post', () => {
    const CHANNEL_UUID = '770e8400-e29b-41d4-a716-446655440002';

    it('posts to banter-api with scheduled_at and returns the scheduled envelope', async () => {
      mockApiOk({
        data: {
          scheduled: true,
          scheduled_message_id: UUID,
          scheduled_at: '2026-05-01T12:00:00Z',
          defer_reason: 'scheduled',
        },
      });
      const result = await getTool('banter_schedule_post').handler({
        channel_id: CHANNEL_UUID,
        content: 'morning update',
        scheduled_at: '2026-05-01T12:00:00Z',
      });
      expect(result.isError).toBeUndefined();
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/v1/channels/${CHANNEL_UUID}/messages`);
      const body = JSON.parse(call[1].body);
      expect(body.scheduled_at).toBe('2026-05-01T12:00:00Z');
      // respect_quiet_hours is a placeholder flag; it must not be forwarded
      // because the banter-api schema does not yet accept it.
      expect('respect_quiet_hours' in body).toBe(false);
    });

    it('surfaces banter-api errors cleanly', async () => {
      mockApiError(400, { error: { code: 'INVALID_SCHEDULED_AT', message: 'scheduled_at in past' } });
      const result = await getTool('banter_schedule_post').handler({
        channel_id: CHANNEL_UUID,
        content: 'too late',
        scheduled_at: '2000-01-01T00:00:00Z',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ===== §7 WAVE 5 DEDUPE =====

  describe('dedupe tools (§7 Wave 5)', () => {
    const CONTACT_A = '00000000-0000-0000-0000-0000000000aa';
    const CONTACT_B = '00000000-0000-0000-0000-0000000000bb';
    const TICKET_A = '00000000-0000-0000-0000-0000000000cc';

    it('bond_find_duplicates hits bond-api without duplicating /v1', async () => {
      mockApiOk({ source_contact_id: CONTACT_A, candidates: [] });
      await getTool('bond_find_duplicates').handler({ contact_id: CONTACT_A, limit: 5 });
      const call = mockFetch.mock.calls[0]!;
      // BOND_API_URL in the harness is http://localhost:4009 without /v1.
      // dedupe-tools.ts sends /contacts/:id/duplicates and relies on the
      // base URL carrying whatever prefix the deployment uses.
      expect(call[0]).toBe(`http://localhost:4009/contacts/${CONTACT_A}/duplicates?limit=5`);
      expect(call[1].method).toBe('GET');
    });

    it('helpdesk_find_similar_tickets hits the /helpdesk/agents/tickets route', async () => {
      mockApiOk({ source_ticket_id: TICKET_A, candidates: [] });
      await getTool('helpdesk_find_similar_tickets').handler({
        ticket_id: TICKET_A,
        status_filter: 'open',
        limit: 7,
        window_days: 14,
      });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain(`/helpdesk/agents/tickets/${TICKET_A}/similar`);
      expect(call[0]).toContain('status_filter=open');
      expect(call[0]).toContain('limit=7');
      expect(call[0]).toContain('window_days=14');
      expect(call[1].method).toBe('GET');
    });

    it('dedupe_record_decision POSTs the canonical body to /v1/dedupe-decisions', async () => {
      mockApiOk({ data: { id: UUID, decision: 'not_duplicate' }, created: true });
      await getTool('dedupe_record_decision').handler({
        entity_type: 'bond.contact',
        id_a: CONTACT_B,
        id_b: CONTACT_A,
        decision: 'not_duplicate',
        reason: 'different companies',
        confidence: 0.82,
      });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/v1/dedupe-decisions');
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body as string);
      // The tool does NOT sort ids itself; canonicalization happens
      // server-side in recordDecision. This is a coverage assertion that
      // the tool forwards inputs verbatim.
      expect(body.id_a).toBe(CONTACT_B);
      expect(body.id_b).toBe(CONTACT_A);
      expect(body.decision).toBe('not_duplicate');
      expect(body.confidence).toBe(0.82);
    });

    it('dedupe_record_decision surfaces 409 HUMAN_DECISION_EXISTS as an isError result', async () => {
      mockApiError(409, {
        error: { code: 'HUMAN_DECISION_EXISTS', message: 'blocked' },
        prior_decision: { decision: 'not_duplicate', decided_by: UUID },
      });
      const result = await getTool('dedupe_record_decision').handler({
        entity_type: 'bond.contact',
        id_a: CONTACT_A,
        id_b: CONTACT_B,
        decision: 'duplicate',
      });
      expectErrorFormat(result);
      expect(result.content[0]!.text).toContain('HUMAN_DECISION_EXISTS');
    });

    it('dedupe_list_pending builds a query string from optional filters', async () => {
      mockApiOk({ pending: [] });
      await getTool('dedupe_list_pending').handler({
        entity_type: 'helpdesk.ticket',
        limit: 25,
      });
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toContain('/v1/dedupe-decisions/pending');
      expect(call[0]).toContain('entity_type=helpdesk.ticket');
      expect(call[0]).toContain('limit=25');
      expect(call[1].method).toBe('GET');
    });

    it('dedupe_list_pending omits the query string when no filters are given', async () => {
      mockApiOk({ pending: [] });
      await getTool('dedupe_list_pending').handler({});
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toMatch(/\/v1\/dedupe-decisions\/pending$/);
    });
  });

  // ===== TOOL REGISTRATION COMPLETENESS =====

  describe('tool registration', () => {
    it('registers all expected tools', () => {
      const expectedTools = [
        // project
        'list_projects', 'get_project', 'create_project',
        'test_slack_webhook', 'disconnect_github_integration',
        // bam resolver
        'bam_list_phases', 'bam_list_labels', 'bam_list_states', 'bam_list_epics',
        // board (whiteboard collaboration)
        'board_list', 'board_get', 'board_create', 'board_update', 'board_archive',
        'board_read_elements', 'board_read_stickies', 'board_read_frames',
        'board_add_sticky', 'board_add_text', 'board_promote_to_tasks',
        'board_export', 'board_summarize', 'board_search',
        // task
        'search_tasks', 'get_task', 'create_task', 'update_task',
        'move_task', 'delete_task', 'bulk_update_tasks', 'log_time',
        'duplicate_task', 'import_csv', 'bam_get_task_by_human_id',
        // task parent/subtask many-to-many (B3 Frndo Launch)
        'bam_add_task_parent', 'bam_remove_task_parent',
        'bam_list_task_parents', 'bam_list_task_subtasks',
        // sprint
        'list_sprints', 'create_sprint', 'start_sprint', 'complete_sprint', 'get_sprint_report',
        // comment
        'list_comments', 'add_comment',
        // member
        'list_members', 'get_my_tasks', 'bam_find_user', 'bam_find_user_by_email',
        // org admin (B3 Frndo Launch)
        'bam_invite_member', 'bam_admin_reset_password', 'bam_send_password_reset_link',
        // report
        'get_velocity_report', 'get_burndown', 'get_cumulative_flow',
        'get_overdue_tasks', 'get_workload', 'get_status_distribution',
        'get_cycle_time_report', 'get_time_tracking_report',
        // template
        'list_templates', 'create_from_template',
        // import
        'import_github_issues', 'suggest_branch_name',
        // me
        'get_me', 'update_me', 'list_my_orgs', 'switch_active_org',
        'change_my_password', 'logout',
        'list_my_notifications', 'mark_notification_read',
        'mark_notifications_read', 'mark_all_notifications_read',
        // platform (superuser)
        'get_platform_settings', 'set_public_signup_disabled',
        'set_helpdesk_signup_disabled',
        'platform_list_orgs', 'platform_create_org', 'platform_get_org',
        'platform_update_org', 'platform_delete_org',
        'get_launchpad_apps', 'set_platform_launchpad_defaults', 'set_org_launchpad_apps',
        'list_beta_signups', 'get_public_config', 'submit_beta_signup',
        // agent (AGENTIC_TODO §10)
        'agent_heartbeat', 'agent_audit', 'agent_self_report',
        // proposals (AGENTIC_TODO §9 Wave 2)
        'proposal_create', 'proposal_list', 'proposal_decide',
        // visibility preflight (AGENTIC_TODO §11 Wave 2)
        'can_access',
        // cross-app unified search (AGENTIC_TODO §2 Wave 3)
        'search_everything',
        // fuzzy entity resolver (AGENTIC_TODO §3 Wave 3)
        'resolve_references',
        // unified activity-log querying (AGENTIC_TODO §5 Wave 3)
        'activity_query',
        'activity_by_actor',
        // composite subject-centric views (AGENTIC_TODO §6 Wave 3)
        'account_view',
        'project_view',
        'user_view',
        // §16 Wave 4 entity links
        'entity_links_list',
        'entity_link_create',
        'entity_link_remove',
        // §17 Wave 4 attachments
        'attachment_get',
        'attachment_list',
        // §13 Wave 4 scheduled banter — the full banter tool suite is
        // registered by registerBanterTools above. banter_schedule_post is
        // the §13 addition; every other name predates Wave 4.
        'banter_add_channel_members',
        'banter_add_group_members',
        'banter_archive_channel',
        'banter_browse_channels',
        'banter_create_channel',
        'banter_create_user_group',
        'banter_delete_channel',
        'banter_delete_message',
        'banter_edit_message',
        'banter_end_call',
        'banter_find_user_by_email',
        'banter_find_user_by_handle',
        'banter_get_active_huddle',
        'banter_get_call',
        'banter_get_channel',
        'banter_get_channel_by_name',
        'banter_get_message',
        'banter_get_preferences',
        'banter_get_transcript',
        'banter_get_unread',
        'banter_get_user_group_by_handle',
        'banter_invite_agent_to_call',
        'banter_join_call',
        'banter_join_channel',
        'banter_leave_call',
        'banter_leave_channel',
        'banter_list_calls',
        'banter_list_channels',
        'banter_list_messages',
        'banter_list_thread_replies',
        'banter_list_user_groups',
        'banter_list_users',
        'banter_pin_message',
        'banter_post_call_text',
        'banter_post_message',
        'banter_react',
        'banter_remove_channel_member',
        'banter_remove_group_member',
        'banter_reply_to_thread',
        'banter_schedule_post',
        'banter_search_messages',
        'banter_search_transcripts',
        'banter_send_dm',
        'banter_send_group_dm',
        'banter_set_presence',
        'banter_share_sprint',
        'banter_share_task',
        'banter_share_ticket',
        'banter_start_call',
        'banter_unpin_message',
        'banter_update_channel',
        'banter_update_preferences',
        'banter_update_user_group',
        // beacon
        'beacon_create', 'beacon_list', 'beacon_get', 'beacon_update',
        'beacon_retire', 'beacon_publish', 'beacon_verify', 'beacon_challenge',
        'beacon_restore', 'beacon_versions', 'beacon_version_get',
        'beacon_search', 'beacon_suggest', 'beacon_search_context',
        'beacon_policy_get', 'beacon_policy_set', 'beacon_policy_resolve',
        'beacon_tags_list', 'beacon_tag_add', 'beacon_tag_remove',
        'beacon_link_create', 'beacon_link_remove',
        'beacon_query_save', 'beacon_query_list', 'beacon_query_get', 'beacon_query_delete',
        'beacon_graph_neighbors', 'beacon_graph_hubs', 'beacon_graph_recent',
        // §14 Wave 4 upserts. bond_upsert_contact and helpdesk_upsert_user
        // land via the bond-tools and helpdesk-tools suites registered below.
        'beacon_upsert_by_slug',
        'task_upsert_by_external_id',
        // §15 Wave 5 agent policies
        'agent_policy_get',
        'agent_policy_set',
        'agent_policy_list',
        // §20 Wave 5 webhooks
        'agent_webhook_configure',
        'agent_webhook_rotate_secret',
        'agent_webhook_deliveries_list',
        'agent_webhook_redeliver',
        // §12 Wave 5 bolt observability
        'bolt_event_trace',
        'bolt_recent_events',
        // §18 + §19 Wave 5 misc. book_find_meeting_time_for_users lands via
        // the book-tools suite registered below.
        'ingest_fingerprint_check',
        // §7 Wave 5 dedupe
        'bond_find_duplicates',
        'helpdesk_find_similar_tickets',
        'dedupe_record_decision',
        'dedupe_list_pending',
        // §4 + §8 Wave 5 trends/expertise
        'helpdesk_ticket_count_by_phrase',
        'bam_task_count_by_phrase',
        'expertise_for_topic',
        // §1 Wave 5 banter subs
        'banter_subscribe_pattern',
        'banter_unsubscribe_pattern',
        'banter_list_subscriptions',
        // Peer-app tool suites registered in beforeEach above.
        // user-resolver
        'find_user_by_email', 'find_user_by_name', 'list_users',
        // helpdesk
        'get_ticket', 'helpdesk_get_public_settings', 'helpdesk_get_settings',
        'helpdesk_get_ticket_by_number', 'helpdesk_search_tickets',
        'helpdesk_set_default_project', 'helpdesk_update_settings',
        'helpdesk_upsert_user', 'list_tickets', 'reply_to_ticket',
        'update_ticket_status',
        // brief
        'brief_append_content', 'brief_archive', 'brief_comment_add',
        'brief_comment_list', 'brief_comment_resolve', 'brief_create',
        'brief_duplicate', 'brief_get', 'brief_link_task', 'brief_list',
        'brief_promote_to_beacon', 'brief_restore', 'brief_search',
        'brief_update', 'brief_update_content', 'brief_version_get',
        'brief_version_restore', 'brief_versions',
        // bolt
        'bolt_actions', 'bolt_create', 'bolt_delete', 'bolt_disable',
        'bolt_enable', 'bolt_events', 'bolt_execution_detail',
        'bolt_executions', 'bolt_get', 'bolt_get_automation_by_name',
        'bolt_list', 'bolt_test', 'bolt_update',
        // bearing
        'bearing_at_risk', 'bearing_goal_create', 'bearing_goal_get',
        'bearing_goal_update', 'bearing_goals', 'bearing_kr_create',
        'bearing_kr_link', 'bearing_kr_update', 'bearing_period_get',
        'bearing_periods', 'bearing_report', 'bearing_update_post',
        // bond
        'bond_close_deal_lost', 'bond_close_deal_won', 'bond_create_company',
        'bond_create_contact', 'bond_create_deal', 'bond_get_company',
        'bond_get_contact', 'bond_get_deal', 'bond_get_forecast',
        'bond_get_pipeline_summary', 'bond_get_stale_deals',
        'bond_list_companies', 'bond_list_contacts', 'bond_list_deals',
        'bond_log_activity', 'bond_merge_contacts', 'bond_move_deal_stage',
        'bond_score_lead', 'bond_search_contacts', 'bond_update_company',
        'bond_update_contact', 'bond_update_deal', 'bond_upsert_contact',
        // blast
        'blast_check_unsubscribed', 'blast_create_segment',
        'blast_create_template', 'blast_draft_campaign',
        'blast_draft_email_content', 'blast_get_campaign',
        'blast_get_campaign_analytics', 'blast_get_engagement_summary',
        'blast_get_template', 'blast_list_segments', 'blast_list_templates',
        'blast_preview_segment', 'blast_send_campaign',
        'blast_suggest_subject_lines',
        // book
        'book_cancel_event', 'book_create_booking_page', 'book_create_event',
        'book_find_meeting_time', 'book_find_meeting_time_for_users',
        'book_get_availability', 'book_get_team_availability',
        'book_get_timeline', 'book_list_events', 'book_rsvp_event',
        'book_update_event',
        // bench
        'bench_compare_periods', 'bench_detect_anomalies',
        'bench_generate_report', 'bench_get_dashboard',
        'bench_list_dashboards', 'bench_list_data_sources',
        'bench_list_scheduled_reports', 'bench_list_widgets',
        'bench_query_ad_hoc', 'bench_query_widget',
        'bench_summarize_dashboard',
        // bill
        'bill_add_line_item', 'bill_create_expense', 'bill_create_invoice',
        'bill_create_invoice_from_deal', 'bill_create_invoice_from_time',
        'bill_finalize_invoice', 'bill_get_invoice', 'bill_get_overdue',
        'bill_get_profitability', 'bill_get_revenue_summary',
        'bill_list_clients', 'bill_list_expenses', 'bill_list_invoices',
        'bill_record_payment', 'bill_resolve_rate', 'bill_send_invoice',
        // blank
        'blank_create_form', 'blank_export_submissions',
        'blank_generate_form', 'blank_get_form', 'blank_get_form_analytics',
        'blank_get_submission', 'blank_list_forms', 'blank_list_submissions',
        'blank_publish_form', 'blank_summarize_responses',
        'blank_update_form',
        // blueprint
        'blueprint_list', 'blueprint_get', 'blueprint_read_nodes',
        'blueprint_read_edges', 'blueprint_search', 'blueprint_export',
        'blueprint_create', 'blueprint_update', 'blueprint_archive',
        'blueprint_add_node', 'blueprint_update_node', 'blueprint_move_node',
        'blueprint_delete_node', 'blueprint_add_edge', 'blueprint_update_edge',
        'blueprint_delete_edge', 'blueprint_apply_layout', 'blueprint_generate',
        'blueprint_promote_node_to_task', 'blueprint_link_entity',
      ];

      for (const name of expectedTools) {
        expect(tools.has(name), `Tool "${name}" should be registered`).toBe(true);
      }

      expect(tools.size).toBe(expectedTools.length);
    });

    it('all tools have descriptions', () => {
      for (const [name, tool] of tools) {
        expect(tool.description, `Tool "${name}" should have a description`).toBeTruthy();
        expect(typeof tool.description).toBe('string');
      }
    });

    it('all tools have handler functions', () => {
      for (const [name, tool] of tools) {
        expect(typeof tool.handler, `Tool "${name}" should have a handler`).toBe('function');
      }
    });
  });
});
