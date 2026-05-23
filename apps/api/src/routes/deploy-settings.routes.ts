// SuperUser Deploy Settings routes.
//
// Backend for the Deploy Settings card on the Platform tab. Companion to
// the Wave F SU permissions editor; reads/writes four keys in
// system_settings (deploy_branch / deploy_repo_url / deploy_github_token /
// deploy_auto_update_enabled) and verifies the configured GitHub repo
// against the GitHub REST API.
//
// All three endpoints require the matching bam.superuser_deploy_settings.*
// permission, which is `requires_superuser=true` in the catalog (delta
// migration 0162) — non-SuperUser callers are short-circuited to 403 by
// the resolver before reaching the handler. See
// docs/plans/deploy-settings-contract.md for the canonical contract.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';
import {
  getDecryptedToken,
  loadDeploySettings,
  saveDeploySettings,
  type SaveDeploySettingsInput,
} from '../services/deploy-settings.service.js';

// ─────────────────────────────────────────────────────────────────────
// PUT body schema.
//
// Each field is optional. For the token field, the contract requires the
// three-state convention: undefined = unchanged, null = clear, string =
// store. zod's `.nullable().optional()` matches this exactly because
// `JSON.parse` distinguishes `{token: null}` from `{}`.
// ─────────────────────────────────────────────────────────────────────
const putBodySchema = z.object({
  deploy_branch: z.string().min(1).max(100).optional(),
  deploy_repo_url: z.string().url().nullable().optional(),
  deploy_github_token: z.string().min(1).max(2000).nullable().optional(),
  deploy_auto_update_enabled: z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────
// URL parser.
//
// Returns { owner, repo } on success, or a string error code on failure.
// Accepts both `https://github.com/owner/repo` and the canonical
// `https://github.com/owner/repo.git`. Rejects any non-github.com host
// with INVALID_URL — only GitHub auth is supported for v1. SSH-form
// URLs (`git@github.com:owner/repo.git`) are also rejected because the
// verifier hits the REST API, not the git protocol.
// ─────────────────────────────────────────────────────────────────────
export function parseGitHubRepoUrl(
  url: string,
): { owner: string; repo: string } | { error: 'INVALID_URL'; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'INVALID_URL', reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'INVALID_URL', reason: 'only http/https URLs are supported' };
  }
  // Strict host check: must be github.com (not a subdomain, not enterprise
  // GitHub). github.com and the rare api.github.com are the only forms
  // we know how to verify against the public REST API.
  if (parsed.host !== 'github.com' && parsed.host !== 'www.github.com') {
    return {
      error: 'INVALID_URL',
      reason: `only github.com is supported (got ${parsed.host})`,
    };
  }
  // Strip leading slash + any trailing .git suffix, then split.
  const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) {
    return { error: 'INVALID_URL', reason: 'path must be /<owner>/<repo>' };
  }
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) {
    return { error: 'INVALID_URL', reason: 'path must be /<owner>/<repo>' };
  }
  return { owner, repo };
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────
export default async function deploySettingsRoutes(fastify: FastifyInstance) {
  // ── GET /superuser/deploy/settings ────────────────────────────────
  fastify.get(
    '/superuser/deploy/settings',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_deploy_settings.get'),
      ],
    },
    async () => {
      const data = await loadDeploySettings();
      return { data };
    },
  );

  // ── PUT /superuser/deploy/settings ────────────────────────────────
  fastify.put(
    '/superuser/deploy/settings',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_deploy_settings.update'),
      ],
    },
    async (request, reply) => {
      const parsed = putBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const userId = request.user!.id;
      const input: SaveDeploySettingsInput = parsed.data;
      const data = await saveDeploySettings(input, userId);

      // Audit. Mask the token in the audit payload — we never want the
      // plaintext (or even the ciphertext) bouncing around the
      // superuser_audit_log JSONB column.
      const auditDetails: Record<string, unknown> = {};
      if (input.deploy_branch !== undefined)
        auditDetails.deploy_branch = input.deploy_branch;
      if (input.deploy_repo_url !== undefined)
        auditDetails.deploy_repo_url = input.deploy_repo_url;
      if (input.deploy_auto_update_enabled !== undefined)
        auditDetails.deploy_auto_update_enabled = input.deploy_auto_update_enabled;
      if (input.deploy_github_token !== undefined) {
        auditDetails.deploy_github_token =
          input.deploy_github_token === null ? 'cleared' : 'set';
      }

      await logSuperuserAction({
        superuserId: userId,
        action: 'update_deploy_settings',
        details: auditDetails,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });

      return { data };
    },
  );

  // ── POST /superuser/deploy/verify-repo ────────────────────────────
  //
  // Verifies a candidate repo URL + token against GitHub's REST API. If
  // the body omits `deploy_github_token`, falls back to the stored
  // (decrypted) token; if neither is present, calls the API
  // unauthenticated (which works for public repos and returns 404 for
  // private ones — same response as a bad repo URL, which is why we
  // emit AUTH_REQUIRED as a hint).
  fastify.post(
    '/superuser/deploy/verify-repo',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_deploy_settings.verify'),
      ],
    },
    async (request, reply) => {
      const verifySchema = z.object({
        deploy_repo_url: z.string().min(1),
        deploy_github_token: z.string().min(1).optional(),
      });
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const urlResult = parseGitHubRepoUrl(parsed.data.deploy_repo_url);
      if ('error' in urlResult) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_URL',
            message: `Invalid repository URL: ${urlResult.reason}`,
            details: [{ deploy_repo_url: parsed.data.deploy_repo_url }],
            request_id: request.id,
          },
        });
      }

      // Token resolution: explicit body value wins; otherwise fall back
      // to the stored decrypted token.
      let token: string | null = null;
      if (parsed.data.deploy_github_token) {
        token = parsed.data.deploy_github_token;
      } else {
        token = await getDecryptedToken();
      }

      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(
        urlResult.owner,
      )}/${encodeURIComponent(urlResult.repo)}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'BigBlueBam-deploy-verifier',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (token) headers.Authorization = `token ${token}`;

      let ghStatus: number;
      let ghBody: unknown;
      try {
        const res = await fetch(apiUrl, {
          method: 'GET',
          headers,
          // 10s should be plenty for a single GitHub API call; if it
          // takes longer than that something is very wrong.
          signal: AbortSignal.timeout(10_000),
        });
        ghStatus = res.status;
        try {
          ghBody = await res.json();
        } catch {
          ghBody = null;
        }
      } catch (err) {
        request.log.warn({ err, apiUrl }, 'deploy verify-repo: GitHub fetch failed');
        return reply.status(400).send({
          error: {
            code: 'VERIFY_FAILED',
            message: `Failed to reach GitHub: ${(err as Error).message ?? 'unknown error'}`,
            details: [],
            request_id: request.id,
          },
        });
      }

      // Happy path: 200 with a repo object.
      if (ghStatus === 200 && ghBody && typeof ghBody === 'object') {
        const body = ghBody as {
          default_branch?: string;
          private?: boolean;
          permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
        };
        const data: Record<string, unknown> = {
          ok: true,
          owner: urlResult.owner,
          repo: urlResult.repo,
          default_branch: body.default_branch ?? null,
          private: body.private ?? false,
        };
        if (body.permissions) data.permissions = body.permissions;
        return reply.send({ data });
      }

      // Failure paths. 404 is the most common — could be a typo'd repo
      // OR a private repo accessed without (or with insufficient) auth.
      // We surface AUTH_REQUIRED as a hint when no token was provided so
      // operators don't burn cycles staring at the URL string.
      if (ghStatus === 404) {
        const code = token ? 'REPO_NOT_FOUND' : 'AUTH_REQUIRED';
        const message = token
          ? `Repository ${urlResult.owner}/${urlResult.repo} not found (or token lacks access)`
          : `Repository ${urlResult.owner}/${urlResult.repo} not found — if this is a private repo, provide a GitHub token`;
        return reply.status(400).send({
          error: {
            code: 'VERIFY_FAILED',
            message,
            details: [{ github_status: ghStatus, hint: code }],
            request_id: request.id,
          },
        });
      }
      if (ghStatus === 401) {
        return reply.status(400).send({
          error: {
            code: 'VERIFY_FAILED',
            message: 'GitHub rejected the token (401 Unauthorized)',
            details: [{ github_status: ghStatus, hint: 'INVALID_TOKEN' }],
            request_id: request.id,
          },
        });
      }
      if (ghStatus === 403) {
        return reply.status(400).send({
          error: {
            code: 'VERIFY_FAILED',
            message: 'GitHub denied access (403 Forbidden) — token may lack scope or be rate-limited',
            details: [{ github_status: ghStatus, hint: 'INVALID_TOKEN' }],
            request_id: request.id,
          },
        });
      }

      return reply.status(400).send({
        error: {
          code: 'VERIFY_FAILED',
          message: `GitHub returned ${ghStatus}`,
          details: [{ github_status: ghStatus }],
          request_id: request.id,
        },
      });
    },
  );
}
