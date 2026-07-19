import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link2, Search, BookOpen, ArrowRight, X, FileText, FileType } from 'lucide-react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import manual from '@/content/manual.generated.json';
import imageDimsRaw from '@/content/manual-image-dims.generated.json';

// src -> [width, height], used to reserve image space (no lazy-load layout
// shift, so anchor-scrolling lands on the clicked section first try).
const imageDims = imageDimsRaw as Record<string, number[]>;

/* ------------------------------------------------------------------ */
/*  Manual image: click to enlarge to near-full-window (light only;    */
/*  the docs deliberately don't do the marketing site's dark hover).   */
/*  Rendered as an inline <img> + a body-portal overlay so it stays    */
/*  valid inside markdown <p> wrappers.                                */
/* ------------------------------------------------------------------ */
function ManualImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  if (!src) return null;
  const dim = imageDims[src];
  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        onClick={() => setOpen(true)}
        title="Click to enlarge"
        // Reserve the exact box before the image loads so lazy-loading doesn't
        // shift the layout (which made far-section anchor scrolls land short).
        style={dim ? { aspectRatio: `${dim[0]} / ${dim[1]}` } : undefined}
        className="my-6 w-full cursor-zoom-in rounded-lg border border-zinc-200 shadow-md transition hover:shadow-lg"
      />
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={alt ?? 'Enlarged screenshot'}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[200] flex cursor-zoom-out items-center justify-center bg-black/85 p-4 backdrop-blur-sm sm:p-6"
          >
            <img
              src={src}
              alt={alt ?? ''}
              className="max-h-[95vh] max-w-[98vw] rounded-lg shadow-2xl ring-1 ring-white/10"
            />
            <button
              type="button"
              aria-label="Close enlarged screenshot"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
            >
              <X className="h-5 w-5" />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TocEntry {
  anchor: string;
  title: string;
  level: number;
}

interface ManualEntry {
  app: string;
  title: string;
  toc: TocEntry[];
  markdown: string;
}

const entries = manual as ManualEntry[];

/* ------------------------------------------------------------------ */
/*  Slug helper: MUST match scripts/help/build-help-index.mjs          */
/*  so sidebar links (#<app>-<anchor>) land on rendered heading ids.   */
/* ------------------------------------------------------------------ */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** Flatten React children of a heading to plain text for slugging. */
function textFromChildren(children: ReactNode): string {
  if (children == null) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join('');
  if (typeof children === 'object' && 'props' in (children as { props?: { children?: ReactNode } })) {
    return textFromChildren((children as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/*  Heading with deep-link copy affordance                            */
/* ------------------------------------------------------------------ */

function CopyableHeading({
  as: Tag,
  id,
  className,
  children,
}: {
  as: 'h2' | 'h3' | 'h4';
  id: string;
  className: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copyLink = useCallback(() => {
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', `#${id}`);
    } else {
      window.location.hash = id;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        },
        () => {},
      );
    }
  }, [id]);

  return (
    <Tag id={id} className={clsx('group scroll-mt-24', className)}>
      <span>{children}</span>
      <button
        type="button"
        onClick={copyLink}
        aria-label={`Copy link to "${textFromChildren(children)}"`}
        title={copied ? 'Link copied!' : 'Copy link to this section'}
        className="ml-2 inline-flex translate-y-[-1px] items-center align-middle text-primary-400 opacity-0 transition-opacity duration-150 hover:text-primary-600 group-hover:opacity-100 focus:opacity-100"
      >
        <Link2 className="h-[0.7em] w-[0.7em]" />
      </button>
      {copied && (
        <span className="ml-1 align-middle text-xs font-normal text-primary-600">copied</span>
      )}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Per-app markdown renderer                                          */
/*  Heading ids are namespaced `<app>-<slug>` so they're globally      */
/*  unique across the 16 stacked apps and match the sidebar links.     */
/* ------------------------------------------------------------------ */

function makeComponents(app: string) {
  return {
    h1: ({ children }: ComponentPropsWithoutRef<'h1'>) => (
      // help.md H1 is the app title; we render our own section header, so
      // demote the in-doc H1 to a quieter lede.
      <p className="mt-2 mb-6 text-lg font-medium text-zinc-500">{children}</p>
    ),
    h2: ({ children }: ComponentPropsWithoutRef<'h2'>) => (
      <CopyableHeading
        as="h2"
        id={`${app}-${slugify(textFromChildren(children))}`}
        className="mt-12 mb-4 border-b border-zinc-200 pb-2 text-2xl font-bold tracking-tight text-zinc-900"
      >
        {children}
      </CopyableHeading>
    ),
    h3: ({ children }: ComponentPropsWithoutRef<'h3'>) => (
      <CopyableHeading
        as="h3"
        id={`${app}-${slugify(textFromChildren(children))}`}
        className="mt-9 mb-3 text-xl font-semibold tracking-tight text-zinc-900"
      >
        {children}
      </CopyableHeading>
    ),
    h4: ({ children }: ComponentPropsWithoutRef<'h4'>) => (
      <CopyableHeading
        as="h4"
        id={`${app}-${slugify(textFromChildren(children))}`}
        className="mt-6 mb-2 text-base font-semibold text-zinc-800"
      >
        {children}
      </CopyableHeading>
    ),
    p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
      <p className="my-4 leading-7 text-zinc-700">{children}</p>
    ),
    a: ({ children, href }: ComponentPropsWithoutRef<'a'>) => {
      const external = href?.startsWith('http');
      return (
        <a
          href={href}
          className="font-medium text-primary-600 underline decoration-primary-300 underline-offset-2 hover:text-primary-700 hover:decoration-primary-500"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {children}
        </a>
      );
    },
    ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
      <ul className="my-4 list-disc space-y-1.5 pl-6 text-zinc-700 marker:text-zinc-400">{children}</ul>
    ),
    ol: ({ children }: ComponentPropsWithoutRef<'ol'>) => (
      <ol className="my-4 list-decimal space-y-1.5 pl-6 text-zinc-700 marker:text-zinc-400">{children}</ol>
    ),
    li: ({ children }: ComponentPropsWithoutRef<'li'>) => <li className="leading-7">{children}</li>,
    blockquote: ({ children }: ComponentPropsWithoutRef<'blockquote'>) => (
      <blockquote className="my-5 border-l-4 border-primary-300 bg-primary-50/50 py-1 pl-4 text-zinc-600 italic">
        {children}
      </blockquote>
    ),
    code: ({ className, children }: ComponentPropsWithoutRef<'code'>) => {
      const isBlock = /language-/.test(className ?? '');
      if (isBlock) {
        return <code className={clsx('font-mono text-sm', className)}>{children}</code>;
      }
      return (
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.85em] text-primary-700">
          {children}
        </code>
      );
    },
    pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => (
      <pre className="my-5 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-900 p-4 text-sm text-zinc-100">
        {children}
      </pre>
    ),
    table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
      <div className="my-6 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }: ComponentPropsWithoutRef<'thead'>) => (
      <thead className="bg-zinc-50">{children}</thead>
    ),
    th: ({ children }: ComponentPropsWithoutRef<'th'>) => (
      <th className="border border-zinc-200 px-3 py-2 font-semibold text-zinc-800">{children}</th>
    ),
    td: ({ children }: ComponentPropsWithoutRef<'td'>) => (
      <td className="border border-zinc-200 px-3 py-2 align-top text-zinc-700">{children}</td>
    ),
    hr: () => <hr className="my-8 border-zinc-200" />,
    img: ({ src, alt }: ComponentPropsWithoutRef<'img'>) => (
      <ManualImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />
    ),
    strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => (
      <strong className="font-semibold text-zinc-900">{children}</strong>
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  Sidebar TOC                                                        */
/* ------------------------------------------------------------------ */

function Sidebar({
  query,
  setQuery,
  activeApp,
  activeSection,
}: {
  query: string;
  setQuery: (v: string) => void;
  activeApp: string | null;
  activeSection: string | null;
}) {
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return entries.map((e) => ({ entry: e, toc: e.toc }));
    return entries
      .map((e) => {
        const appMatches = e.title.toLowerCase().includes(q) || e.app.includes(q);
        const toc = appMatches ? e.toc : e.toc.filter((t) => t.title.toLowerCase().includes(q));
        if (appMatches || toc.length > 0) return { entry: e, toc };
        return null;
      })
      .filter((x): x is { entry: ManualEntry; toc: TocEntry[] } => x !== null);
  }, [q]);

  const onNavClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (window.history?.replaceState) window.history.replaceState(null, '', `#${id}`);
    }
  }, []);

  return (
    <nav className="flex h-full flex-col">
      {/* Search */}
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sections…"
          aria-label="Filter manual sections"
          className="w-full rounded-lg border border-zinc-200 bg-white py-2 pr-3 pl-9 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-primary-400 focus:ring-2 focus:ring-primary-100 focus:outline-none"
        />
      </div>

      <div className="-mr-2 flex-1 overflow-y-auto pr-2">
        {filtered.length === 0 && (
          <p className="px-2 py-4 text-sm text-zinc-400">No sections match "{query}".</p>
        )}
        <ul className="space-y-5">
          {filtered.map(({ entry, toc }) => {
            const appId = entry.app;
            const isActiveApp = activeApp === appId;
            return (
              <li key={entry.app}>
                <a
                  href={`#${appId}`}
                  onClick={(e) => onNavClick(e, appId)}
                  className={clsx(
                    'block rounded-md px-2 py-1 text-sm font-bold tracking-tight transition-colors',
                    isActiveApp
                      ? 'bg-primary-50 text-primary-700'
                      : 'text-zinc-900 hover:bg-zinc-50',
                  )}
                >
                  {entry.title}
                </a>
                {toc.length > 0 && (
                  <ul className="mt-1 space-y-0.5 border-l border-zinc-200 pl-3">
                    {toc.map((t) => {
                      const id = `${appId}-${t.anchor}`;
                      const isActive = activeSection === id;
                      return (
                        <li key={id}>
                          <a
                            href={`#${id}`}
                            onClick={(e) => onNavClick(e, id)}
                            className={clsx(
                              'block rounded px-2 py-1 text-[13px] leading-snug transition-colors',
                              t.level >= 3 ? 'pl-3' : '',
                              isActive
                                ? 'font-medium text-primary-700'
                                : 'text-zinc-500 hover:text-zinc-900',
                            )}
                          >
                            {t.title}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/*  Manual page                                                        */
/* ------------------------------------------------------------------ */

export function ManualPage() {
  const [query, setQuery] = useState('');
  const [activeApp, setActiveApp] = useState<string | null>(entries[0]?.app ?? null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Deep-link: on mount, scroll the hash target into view once content renders.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    // Defer until after react-markdown has painted heading ids.
    const t = setTimeout(() => {
      const el = document.getElementById(decodeURIComponent(hash));
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, 120);
    return () => clearTimeout(t);
  }, []);

  // Scroll-spy: track the nearest heading above the fold to highlight in the TOC.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const headings = Array.from(
      root.querySelectorAll<HTMLElement>('section[id], h2[id], h3[id]'),
    );
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (observed) => {
        // Pick the topmost intersecting heading.
        const visible = observed
          .filter((o) => o.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length === 0) return;
        const id = (visible[0].target as HTMLElement).id;
        const tag = (visible[0].target as HTMLElement).tagName.toLowerCase();
        if (tag === 'section') {
          setActiveApp(id);
        } else {
          setActiveSection(id);
          // Section ids are `<app>-<anchor>`; derive the owning app.
          const owner = entries.find((e) => id.startsWith(`${e.app}-`));
          if (owner) setActiveApp(owner.app);
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-white">
      <Navbar />

      <main className="mx-auto max-w-7xl px-4 pt-28 pb-24 sm:px-6 lg:px-8">
        {/* Intro header */}
        <header className="mb-10 border-b border-zinc-200 pb-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-primary-50 px-3 py-1 text-sm font-medium text-primary-700">
            <BookOpen className="h-4 w-4" />
            Manual
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl">
            The BigBlueBam Manual
          </h1>
          <p className="mt-3 max-w-2xl text-lg text-zinc-600">
            Everything about every app, in one place. Use the sidebar to jump between products and
            sections, the filter box for quick navigation, or your browser's find (Ctrl/Cmd+F) to
            search the full text. Every section has a shareable deep link. Hover a heading and
            click the link icon.
          </p>
          <p className="mt-4 text-sm text-zinc-500">
            Looking to install or operate the suite?{' '}
            <a
              href="/deploy"
              className="inline-flex items-center gap-1 font-medium text-primary-600 hover:text-primary-700"
            >
              Read the deployment guide
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </p>

          {/* Download the printable, textbook-style edition of this manual. */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href="/downloads/BigBlueBam-Manual.pdf"
              download
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700"
            >
              <FileText className="h-4 w-4" />
              Download PDF
            </a>
            <a
              href="/downloads/BigBlueBam-Manual.docx"
              download
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50"
            >
              <FileType className="h-4 w-4" />
              Download DOCX
            </a>
            <span className="text-sm text-zinc-500">
              The complete textbook edition: every app, with review quizzes, a glossary, and an index.
            </span>
          </div>
        </header>

        <div className="lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-10">
          {/* Sidebar */}
          <aside className="mb-10 lg:mb-0">
            <div className="lg:sticky lg:top-24 lg:h-[calc(100vh-7rem)]">
              <Sidebar
                query={query}
                setQuery={setQuery}
                activeApp={activeApp}
                activeSection={activeSection}
              />
            </div>
          </aside>

          {/* Content: all 21 apps stacked */}
          <div ref={contentRef} className="min-w-0">
            {entries.map((entry) => (
              <section
                key={entry.app}
                id={entry.app}
                className="scroll-mt-24 border-t border-zinc-100 pt-10 first:border-t-0 first:pt-0"
              >
                <div className="mb-6 flex items-baseline gap-3">
                  <h2 className="text-3xl font-extrabold tracking-tight text-zinc-900">
                    {entry.title}
                  </h2>
                  <span className="font-mono text-sm text-zinc-400">/{entry.app}</span>
                </div>
                <div className="max-w-3xl text-[15px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeComponents(entry.app)}>
                    {entry.markdown}
                  </ReactMarkdown>
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
