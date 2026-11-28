import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, cleanup } from '@testing-library/react';

vi.mock('@bigbluebam/ui/impersonation-banner', () => ({ impersonateHeader: () => ({}), getImpersonation: () => null }));

import { ReadinessPage } from '@/pages/readiness';
import { jsonResponse, routedFetch, wrap } from './helpers';

// The shared theme rules every SPA imports from its globals.css. Native <select> option lists
// are drawn by the browser, so in dark mode they need color-scheme: dark and dark option colors.
const THEME_CSS = readFileSync(resolve(__dirname, '../../../packages/ui/theme.css'), 'utf8');
const GLOBALS_CSS = readFileSync(resolve(__dirname, '../src/styles/globals.css'), 'utf8');

const NUMBERS = { proven_by_suite: 1, proven_by_evidence: 0, not_met: 0, risk_accepted: 0, cant_prove: 0, not_set_up: 0, checked: 1, total: 1 };

let style: HTMLStyleElement;

beforeEach(() => {
  style = document.createElement('style');
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
  document.documentElement.classList.add('dark');
  vi.stubGlobal(
    'fetch',
    routedFetch({
      'GET /bastion/api/v1/summary': () =>
        jsonResponse(200, {
          data: {
            frameworks: [
              { id: 'f-soc', template_key: 'soc2', name: 'SOC 2', audit_target_date: null },
              { id: 'f-iso', template_key: 'iso27001', name: 'ISO 27001', audit_target_date: null },
            ],
            selected: null, nearest_audit_date: null, days_to_audit: null, numbers: NUMBERS,
            headline: '1 of 1 controls checked', not_met_label: 'Not met: 0', not_applicable: [], banners: [],
            top_gaps: [], gaps_ranked: false, expiring_evidence: [], last_full_run_at: null, timezone: 'UTC', as_of: '2026-11-26T10:00:00Z',
          },
        }),
    }),
  );
});

afterEach(() => {
  cleanup();
  style.remove();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('dark-mode native dropdowns', () => {
  it('globals.css imports the shared theme rules', () => {
    expect(GLOBALS_CSS).toContain('@import "../../../../packages/ui/theme.css";');
  });

  it('the Readiness framework picker draws its options dark in dark mode', async () => {
    wrap(<ReadinessPage />);
    const select = await screen.findByLabelText('Framework');
    expect(getComputedStyle(document.documentElement).getPropertyValue('color-scheme')).toBe('dark');
    const options = select.querySelectorAll('option');
    expect(options.length).toBeGreaterThan(1);
    for (const opt of options) {
      const cs = getComputedStyle(opt);
      expect(cs.backgroundColor).toBe('rgb(24, 24, 27)');
      expect(cs.color).toBe('rgb(244, 244, 245)');
    }
  });

  it('light mode leaves the options to the browser default', async () => {
    document.documentElement.classList.remove('dark');
    wrap(<ReadinessPage />);
    const select = await screen.findByLabelText('Framework');
    expect(getComputedStyle(document.documentElement).getPropertyValue('color-scheme')).toBe('light');
    expect(getComputedStyle(select.querySelector('option') as HTMLOptionElement).backgroundColor).not.toBe('rgb(24, 24, 27)');
  });
});
