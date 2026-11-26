import { describe, expect, it } from 'vitest';
import { bastionStopGraceProblem } from '../src/boot/stop-grace.js';

// #284: raising BASTION_LLM_TIMEOUT_MS past what the platform's stop grace can drain is refused at
// boot (env.ts superRefine calls this), naming the setting to raise, instead of SIGKILLing an AI
// call mid-flight on every deploy.

describe('bastion-api stop grace vs. LLM deadline (#284)', () => {
  it('the defaults fit', () => {
    expect(bastionStopGraceProblem({ BASTION_LLM_TIMEOUT_MS: 60_000 })).toBeNull();
    expect(bastionStopGraceProblem({ BASTION_LLM_TIMEOUT_MS: 60_000, STOP_GRACE_SECONDS: '75' })).toBeNull();
  });

  it('180 s against 75 s is refused under compose, naming BASTION_STOP_GRACE_SECONDS and 190', () => {
    const p = bastionStopGraceProblem({ BASTION_LLM_TIMEOUT_MS: 180_000, STOP_GRACE_SECONDS: '75' });
    expect(p).toContain('190');
    expect(p).toContain('BASTION_STOP_GRACE_SECONDS');
    expect(bastionStopGraceProblem({ BASTION_LLM_TIMEOUT_MS: 180_000, STOP_GRACE_SECONDS: '190' })).toBeNull();
  });

  it('on Railway the draining variable is what counts', () => {
    const p = bastionStopGraceProblem({ BASTION_LLM_TIMEOUT_MS: 120_000, STOP_GRACE_SECONDS: '300', RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '75' });
    expect(p).toContain('RAILWAY_DEPLOYMENT_DRAINING_SECONDS');
    expect(bastionStopGraceProblem({ BASTION_LLM_TIMEOUT_MS: 120_000, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '130' })).toBeNull();
  });
});
