// Wave G — SuperUser deploy settings API client.
// Mirrors the contract in `docs/plans/deploy-settings-contract.md`.
// All routes live under /superuser/deploy/* and are SU-gated by the backend.

import { api } from '@/lib/api';

// ─── Response / payload shapes ──────────────────────────────────────────────

export interface DeploySettingsData {
  /** Current configured branch (or the default if no override is stored). */
  deploy_branch: string;
  /** Current configured repo URL (or the resolved default origin). */
  deploy_repo_url: string | null;
  /** Boolean indicator: is an encrypted GitHub token stored? Never the token itself. */
  deploy_github_token_set: boolean;
  /** Whether the deploy script will pull updates automatically when run. */
  deploy_auto_update_enabled: boolean;
  /** Hardcoded fallbacks the UI can render as "(default)" hints. */
  defaults: {
    deploy_branch: string;
    deploy_repo_url: string | null;
  };
}

export interface DeploySettingsResponse {
  data: DeploySettingsData;
}

/**
 * Update payload — every field is optional. Token field uses the
 * omit-vs-null-vs-string convention:
 *  - omitted → leave the stored token unchanged
 *  - null    → clear the stored token
 *  - string  → encrypt and store the supplied token
 *
 * branch / repo_url can also be set to null to mean "revert to default".
 */
export interface UpdateDeploySettingsInput {
  deploy_branch?: string | null;
  deploy_repo_url?: string | null;
  deploy_github_token?: string | null;
  deploy_auto_update_enabled?: boolean;
}

export interface VerifyRepoInput {
  deploy_repo_url: string;
  /** Optional override token. If omitted, server uses the stored token. */
  deploy_github_token?: string;
}

export interface VerifyRepoSuccess {
  ok: true;
  owner: string;
  repo: string;
  default_branch: string;
  private: boolean;
  permissions?: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

export interface VerifyRepoResponse {
  data: VerifyRepoSuccess;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export const superuserDeployApi = {
  getDeploySettings(): Promise<DeploySettingsResponse> {
    return api.get<DeploySettingsResponse>('/superuser/deploy/settings');
  },

  updateDeploySettings(body: UpdateDeploySettingsInput): Promise<DeploySettingsResponse> {
    return api.put<DeploySettingsResponse>('/superuser/deploy/settings', body);
  },

  verifyRepo(body: VerifyRepoInput): Promise<VerifyRepoResponse> {
    return api.post<VerifyRepoResponse>('/superuser/deploy/verify-repo', body);
  },
};
