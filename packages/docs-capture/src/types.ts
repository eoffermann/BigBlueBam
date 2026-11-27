import type { Page } from 'playwright';

/** A single screenshot scene for an app. */
export interface Scene {
  /** Filename-safe id, e.g. '01-pipeline'. */
  id: string;
  /** Human-readable label, e.g. 'Pipeline board'. */
  label: string;
  /** Route to navigate to, e.g. '/bond/'. */
  route: string;
  /** CSS selector to wait for before capturing. */
  waitFor?: string;
  /** Custom pre-capture logic (e.g. click a card). */
  setup?: (page: Page) => Promise<void>;
  /** Whether to capture after setup completes. Defaults to true. */
  screenshot_after?: boolean;
}

export interface SnapOptions {
  /** Output file path (absolute). */
  file: string;
  /** Human-readable label for screenshots.json. */
  label: string;
  /** CSS selector to wait for before capture. */
  waitFor?: string;
}

export interface RunScenesOptions {
  /** Base URL of the running stack. Defaults to 'http://localhost'. */
  baseURL?: string;
  /** Output root directory for docs/apps/{app}/screenshots/. */
  outputDir?: string;
}

export type Theme = 'light' | 'dark';

export interface ScreenshotMeta {
  id: string;
  label: string;
  theme: Theme;
  file: string;
  sha256: string;
  width: number;
  height: number;
  captured_at: string;
}
