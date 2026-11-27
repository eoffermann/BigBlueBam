import { env } from '../env.js';

/**
 * Deployment config-health checks for the SuperUser banner
 * (GET /superuser/config-health).
 *
 * The internal service-to-service guards fail closed when
 * INTERNAL_SERVICE_SECRET is unset (@bigbluebam/service-health, #252), so a
 * fresh deploy that forgot the secret silently loses every cross-app call
 * (Bolt event ingest, Banter DMs, Brief/Board internal routes). This surfaces
 * that to a SuperUser in the WebUI instead of leaving it to log archaeology.
 *
 * Read-only and self-contained: it reads this process's environment and makes
 * no service-to-service call, so it works on exactly the misconfigured stack it
 * exists to diagnose. It never returns a secret value, only whether one is set.
 *
 * 'info' items describe posture (permission enforcement, the RLS backstop).
 * They are shown when the banner is open but do not raise it on their own:
 * both default off on purpose during the staged rollout, and a permanent banner
 * for an intended default would teach operators to ignore it.
 */

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

const MIN_SECRET_LENGTH = 32;

export interface ConfigHealthInputs {
  internalServiceSecret: string | undefined;
  sessionSecret: string | undefined;
  permissionsEnforce: string;
  rlsEnforce: string | undefined;
}

function secretItem(
  key: string,
  label: string,
  value: string | undefined,
  missingDetail: string,
  remediation: string,
): ConfigHealthItem {
  let status: HealthStatus = 'ok';
  let detail = 'Configured.';
  if (!value) {
    status = 'critical';
    detail = missingDetail;
  } else if (value.length < MIN_SECRET_LENGTH) {
    status = 'warning';
    detail = `Set, but only ${value.length} characters long. Use at least ${MIN_SECRET_LENGTH}.`;
  }
  return { key, label, category: 'secret', status, detail, remediation };
}

export function evaluateConfigHealth(
  inputs: ConfigHealthInputs = {
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
    sessionSecret: env.SESSION_SECRET,
    permissionsEnforce: env.BBB_PERMISSIONS_ENFORCE,
    rlsEnforce: process.env.BBB_RLS_ENFORCE,
  },
): ConfigHealthResult {
  const items: ConfigHealthItem[] = [
    secretItem(
      'INTERNAL_SERVICE_SECRET',
      'Internal service secret',
      inputs.internalServiceSecret,
      'Not set. The apps refuse each other\'s internal calls until it is, so automations, cross-app notifications and similar features do not work.',
      'Set INTERNAL_SERVICE_SECRET (at least 32 random characters, the same value on every service) in the deployment environment, then restart the services.',
    ),
    secretItem(
      'SESSION_SECRET',
      'Session signing secret',
      inputs.sessionSecret,
      'Not set.',
      'Set SESSION_SECRET (at least 32 random characters) in the deployment environment and restart. Changing it signs everyone out.',
    ),
    {
      key: 'BBB_PERMISSIONS_ENFORCE',
      label: 'Per-action permission enforcement',
      category: 'posture',
      status: inputs.permissionsEnforce === 'on' ? 'ok' : 'info',
      detail:
        inputs.permissionsEnforce === 'on'
          ? 'Enforcing.'
          : `Advisory ('${inputs.permissionsEnforce}'). Per-action permission checks are recorded, not blocked. SuperUser and role guards are enforced regardless.`,
      remediation: 'Set BBB_PERMISSIONS_ENFORCE=on once the permission matrix has been reviewed, then restart.',
    },
    {
      key: 'BBB_RLS_ENFORCE',
      label: 'Database row-level security backstop',
      category: 'posture',
      status: inputs.rlsEnforce === '1' ? 'ok' : 'info',
      detail:
        inputs.rlsEnforce === '1'
          ? 'Enabled.'
          : 'Off. Organization isolation relies on application-level scoping without a database backstop.',
      remediation: 'Set BBB_RLS_ENFORCE=1 and restart once the RLS rollout is complete.',
    },
  ];

  const overall = items.some((i) => i.status === 'critical')
    ? 'critical'
    : items.some((i) => i.status === 'warning')
      ? 'warning'
      : 'ok';
  return { items, overall };
}
