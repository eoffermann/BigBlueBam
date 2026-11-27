import { api } from '@/lib/api';

export type HealthStatus = 'ok' | 'info' | 'warning' | 'critical';

export interface ConfigHealthItem {
  key: string;
  label: string;
  category: 'secret' | 'posture';
  status: HealthStatus;
  detail: string;
  remediation: string;
}

export interface ConfigHealthResult {
  items: ConfigHealthItem[];
  overall: 'ok' | 'warning' | 'critical';
}

export const configHealthApi = {
  getHealth(): Promise<{ data: ConfigHealthResult }> {
    // getQuiet: a 403 here must not trigger the global auth redirect. The
    // banner only queries for SuperUsers anyway.
    return api.getQuiet<{ data: ConfigHealthResult }>('/superuser/config-health');
  },
};
