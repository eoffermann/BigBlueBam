// Deployment state persistence — zero dependencies (node:fs, node:path only).

import * as fs from 'node:fs';
import * as path from 'node:path';

const STATE_FILE = path.resolve(process.cwd(), '.deploy-state.json');

const SECRET_KEYS = ['SESSION_SECRET', 'INTERNAL_HELPDESK_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'S3_SECRET_KEY', 'SMTP_PASSWORD', 'SMTP_PASS', 'LIVEKIT_API_SECRET', 'QDRANT_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

/**
 * Strip secret values from state before persisting to disk.
 */
export function sanitizeState(state) {
  const clean = JSON.parse(JSON.stringify(state));
  if (clean.envConfig) {
    for (const key of SECRET_KEYS) {
      if (clean.envConfig[key]) clean.envConfig[key] = '[REDACTED]';
    }
    // Also redact any *_PASSWORD, *_SECRET, *_KEY, *_SALT, *_PEPPER patterns (the last two
    // cover stable secrets such as BASTION_ROOM_IP_SALT / BASTION_FEED_KEY_PEPPER).
    for (const key of Object.keys(clean.envConfig)) {
      if (/PASSWORD|SECRET|_KEY$|_SALT$|_PEPPER$/i.test(key) && clean.envConfig[key] !== '[REDACTED]') {
        clean.envConfig[key] = '[REDACTED]';
      }
    }
  }
  return clean;
}

/**
 * Load saved deployment state. Returns {} if no state file exists.
 */
export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Persist deployment state to disk (secrets are redacted).
 */
export function saveState(state) {
  const clean = sanitizeState(state);
  fs.writeFileSync(STATE_FILE, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600, encoding: 'utf8' });
}

/**
 * Check whether a given phase has been completed.
 */
export function isPhaseComplete(state, phase) {
  return !!(state.phases && state.phases[phase] && state.phases[phase].completed);
}

/**
 * Mark a phase as complete with a timestamp.
 */
export function markPhaseComplete(state, phase) {
  if (!state.phases) state.phases = {};
  state.phases[phase] = {
    completed: true,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Reset state entirely (for fresh re-deploy).
 */
export function resetState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore if file doesn't exist
  }
}
