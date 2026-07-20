/**
 * Canonical HelpViewer component - shared across all BigBlueBam apps.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/help-viewer' -> '<root>/packages/ui/help-viewer.tsx'
 *
 * Fetches /docs/apps/{appSlug}/guide.md from nginx static serving,
 * converts markdown to sanitized HTML, and renders it with anchor
 * deep-linking support (scroll to #section-id from URL hash).
 *
 * Caches via TanStack Query with a 1-hour stale time. The consumer
 * app provides the QueryClient via its own QueryClientProvider.
 */

import { useEffect, useRef, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { markdownToHtml, sanitizeHtml } from '@bigbluebam/ui/markdown';
import { ArrowLeft, BookOpen, Loader2 } from 'lucide-react';

export interface HelpViewerProps {
  appSlug: string;
  className?: string;
  onBack?: () => void;
}

async function fetchGuide(appSlug: string): Promise<string> {
  const res = await fetch(`/docs/apps/${appSlug}/guide.md`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Failed to load help content (${res.status})`);
  }
  return res.text();
}

export const HelpViewer: FC<HelpViewerProps> = ({ appSlug, className, onBack }) => {
  const contentRef = useRef<HTMLDivElement>(null);

  const { data: markdown, isLoading, error } = useQuery({
    queryKey: ['help-guide', appSlug],
    queryFn: () => fetchGuide(appSlug),
    staleTime: 60 * 60 * 1000, // 1 hour
    retry: 1,
  });

  // Rewrite relative image/link URLs to /docs/apps/<appSlug>/ after render. guide.md
  // uses paths like `screenshots/light/01-x.png`; without this they resolve against
  // the SPA route (e.g. /bursar/help -> /bursar/screenshots/...) and 404. The Help
  // Center (help-center.tsx) does the same rewrite for help.md; HelpViewer was missing
  // it, so every app's full Help page showed broken images.
  useEffect(() => {
    const root = contentRef.current;
    if (!markdown || !root) return;
    const base = `/docs/apps/${appSlug}/`;
    const isAbsolute = (u: string) => /^(https?:|\/|#|data:|mailto:)/.test(u);
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src && !isAbsolute(src)) img.setAttribute('src', base + src);
      img.setAttribute('loading', 'lazy');
    });
    root.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href && !isAbsolute(href)) a.setAttribute('href', base + href);
    });
  }, [markdown, appSlug]);

  // Scroll to anchor from URL hash after content renders
  useEffect(() => {
    if (!markdown || !contentRef.current) return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    // Small delay to let the DOM settle after innerHTML change
    const timer = setTimeout(() => {
      const target = contentRef.current?.querySelector(`#${CSS.escape(hash)}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [markdown]);

  const html = markdown ? sanitizeHtml(markdownToHtml(markdown)) : '';

  return (
    <div className={`min-h-screen bg-white dark:bg-zinc-950 ${className ?? ''}`}>
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
            </button>
          )}
          <BookOpen className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Help</h1>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            <span className="ml-3 text-zinc-500">Loading help content...</span>
          </div>
        )}

        {error && (
          <div className="text-center py-20">
            <BookOpen className="h-10 w-10 text-zinc-300 dark:text-zinc-700 mx-auto mb-4" />
            <p className="text-zinc-500 dark:text-zinc-400">
              Help content is not available yet for this app.
            </p>
            <p className="text-sm text-zinc-400 dark:text-zinc-500 mt-2">
              Documentation is being prepared and will appear here soon.
            </p>
          </div>
        )}

        {html && (
          <div
            ref={contentRef}
            className="help-viewer-content prose prose-zinc dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
};
