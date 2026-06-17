import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/common/button';

/**
 * First-Time User Experience — the guided Settings tour (MVP).
 *
 * Rendered by `SettingsPage` only while `App` has FTUE active (a freshly-logged
 * user whose `notification_prefs.ftue_completed` is unset). It walks the user
 * through the four key Settings controls, switching the page's tab as it goes,
 * then points at the topbar Launchpad button. Completing or skipping calls
 * `onComplete`, which persists the account-level flag so it never fires again.
 *
 * Targets are matched by `[data-ftue="…"]` anchors that `SettingsPage` and the
 * shared Launchpad trigger expose, so the tour is decoupled from exact markup.
 * The spotlight is a single positioned box with a giant `box-shadow` ring —
 * no extra dependency, no layout interference.
 */

export type SettingsTab = 'profile' | 'appearance' | 'notifications';

interface TourStep {
  /** Settings tab to switch to before showing this step (null = no switch). */
  tab: SettingsTab | null;
  /** `[data-ftue="…"]` value of the element to spotlight. */
  anchor: string;
  title: string;
  body: string;
  isLast?: boolean;
}

const STEPS: TourStep[] = [
  {
    tab: 'profile',
    anchor: 'display-name',
    title: 'Set your display name',
    body: 'This is how teammates see you across BigBlueBam — your real name or a handle.',
  },
  {
    tab: 'profile',
    anchor: 'timezone',
    title: 'Pick your timezone',
    body: 'Due dates, sprints, and schedules show in your local time. Choose the city closest to you.',
  },
  {
    tab: 'profile',
    anchor: 'profile-save',
    title: 'Save your profile',
    body: 'Click Save Changes to keep your display name and timezone — they aren’t stored until you do.',
  },
  {
    tab: 'appearance',
    anchor: 'theme',
    title: 'Choose your appearance',
    body: 'Light, dark, or match your system. This one saves instantly — no button needed.',
  },
  {
    tab: 'notifications',
    anchor: 'notifications',
    title: 'Tune your notifications',
    body: 'Pick what you want to hear about. You can revisit these whenever you like.',
  },
  {
    tab: 'notifications',
    anchor: 'notif-save',
    title: 'Save your preferences',
    body: 'Click Save Preferences to keep your notification choices.',
  },
  {
    tab: null,
    anchor: 'launchpad',
    title: 'Find your apps',
    body: "Last thing — click the Launchpad up here to see every app available to you. That's it, you're all set!",
    isLast: true,
  },
];

const PAD = 8; // spotlight padding around the target
const TOOLTIP_W = 320;

/** Track a `[data-ftue="anchor"]` element's viewport rect, re-measuring while it
 *  settles (tab switch + scroll) and on resize/scroll. Returns null until found. */
function useAnchorRect(anchor: string, stepKey: number): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    setRect(null);
    let raf = 0;
    let tries = 0;
    let cancelled = false;
    const sel = `[data-ftue="${anchor}"]`;

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setRect(el.getBoundingClientRect());
      } else if (tries < 90) {
        tries += 1;
        raf = requestAnimationFrame(measure);
      }
    };
    raf = requestAnimationFrame(measure);

    const update = () => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, stepKey]);

  return rect;
}

export function SettingsFtueTour({
  setTab,
  onComplete,
}: {
  setTab: (tab: SettingsTab) => void;
  onComplete: () => void;
}) {
  const [i, setI] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const step = STEPS[i]!;
  const rect = useAnchorRect(step.anchor, i);

  // Switch to the tab this step lives on (Launchpad step has no tab).
  useEffect(() => {
    if (step.tab) setTab(step.tab);
  }, [i, step.tab, setTab]);

  if (dismissed) return null;

  const finish = () => {
    setDismissed(true);
    onComplete();
  };

  // Tooltip placement: below the target if it fits, else above; clamped to the
  // viewport. Falls back to centered when the anchor isn't found yet.
  let tipTop: number;
  let tipLeft: number;
  if (rect) {
    const below = rect.bottom + 12;
    const fitsBelow = below + 180 < window.innerHeight;
    tipTop = fitsBelow ? below : Math.max(12, rect.top - 12 - 180);
    tipLeft = Math.min(
      Math.max(12, rect.left + rect.width / 2 - TOOLTIP_W / 2),
      window.innerWidth - TOOLTIP_W - 12,
    );
  } else {
    tipTop = window.innerHeight / 2 - 90;
    tipLeft = window.innerWidth / 2 - TOOLTIP_W / 2;
  }

  return createPortal(
    // pointer-events-none so the overlay is purely visual — the user can still
    // click the highlighted control (fill in their name, pick a timezone, etc.)
    // and the rest of the page underneath. Only the tooltip card re-enables
    // pointer events for its Back/Next/Skip buttons. (This is a coachmark, not a
    // blocking modal — hence no aria-modal.)
    <div className="pointer-events-none fixed inset-0 z-[100]" role="dialog" aria-label="Getting started">
      {/* Spotlight: a box over the target with a huge shadow dimming the rest. */}
      {rect && (
        <div
          className="pointer-events-none fixed rounded-lg ring-2 ring-primary-400 transition-all duration-200"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      )}
      {/* Backdrop fallback when there's no target rect yet (keeps it modal). */}
      {!rect && <div className="fixed inset-0 bg-black/55" />}

      {/* Tooltip card — re-enables pointer events so its buttons are clickable. */}
      <div
        className="pointer-events-auto fixed rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
        style={{ top: tipTop, left: tipLeft, width: TOOLTIP_W }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-primary-600 dark:text-primary-400">
            Getting started · {i + 1} of {STEPS.length}
          </span>
          <button
            type="button"
            onClick={finish}
            className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            Skip
          </button>
        </div>
        <h3 className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {step.title}
        </h3>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{step.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setI((n) => Math.max(0, n - 1))}
            disabled={i === 0}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-40 disabled:hover:text-zinc-500 dark:hover:text-zinc-200"
          >
            Back
          </button>
          {step.isLast ? (
            <Button size="sm" onClick={finish}>
              Finish
            </Button>
          ) : (
            <Button size="sm" onClick={() => setI((n) => Math.min(STEPS.length - 1, n + 1))}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
