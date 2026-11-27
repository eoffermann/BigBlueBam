import { describe, expect, it } from 'vitest';
import { LLM_CALL_TIMEOUT_MAX_MS, LLM_CLIENT_GRACE_MS } from './llm-deadline.js';
import {
  llmCallDrainMs,
  platformStopGrace,
  SHUTDOWN_EXIT_MARGIN_MS,
  STOP_GRACE_DEFAULT_SECONDS,
  stopGraceNeededMs,
  stopGraceProblem,
} from './stop-grace.js';

// #284 / #294: the shutdown drain is derived from the call deadline; the grace is read from the
// variable the platform itself reads; the two are compared in one place.

describe('stop grace (#284)', () => {
  it('reads Railway first, then STOP_GRACE_SECONDS, else the 75 s default', () => {
    expect(platformStopGrace({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '120', STOP_GRACE_SECONDS: '75' })).toEqual({ ms: 120_000, source: 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS' });
    expect(platformStopGrace({ STOP_GRACE_SECONDS: '190' })).toEqual({ ms: 190_000, source: 'STOP_GRACE_SECONDS' });
    expect(platformStopGrace({})).toEqual({ ms: STOP_GRACE_DEFAULT_SECONDS * 1000, source: 'default' });
    expect(platformStopGrace({ STOP_GRACE_SECONDS: 'soon' }).source).toBe('default');
  });

  it('the drain is the clamped deadline plus the client grace; phases overlap from the signal', () => {
    expect(llmCallDrainMs(60_000)).toBe(60_000 + LLM_CLIENT_GRACE_MS);
    expect(llmCallDrainMs(10 * LLM_CALL_TIMEOUT_MAX_MS)).toBe(LLM_CALL_TIMEOUT_MAX_MS + LLM_CLIENT_GRACE_MS);
    expect(stopGraceNeededMs(30_000, 65_000)).toBe(65_000 + SHUTDOWN_EXIT_MARGIN_MS);
  });

  it('the default 60 s deadline fits the default 75 s grace; 180 s does not, and the message says what to raise', () => {
    const grace = platformStopGrace({});
    expect(stopGraceProblem(grace, stopGraceNeededMs(30_000, llmCallDrainMs(60_000)), 'x')).toBeNull();
    const p = stopGraceProblem(grace, stopGraceNeededMs(30_000, llmCallDrainMs(180_000)), 'An AI call');
    expect(p).toContain('needs 190 s');
    expect(p).toContain('stop_grace_period');
    const r = stopGraceProblem(platformStopGrace({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '75' }), 190_000, 'An AI call');
    expect(r).toContain('RAILWAY_DEPLOYMENT_DRAINING_SECONDS on this Railway service');
  });
});
