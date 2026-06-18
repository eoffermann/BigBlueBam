import { useState, useEffect, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import clsx from 'clsx';

interface ScreenshotFrameProps {
  src: string;
  alt: string;
  className?: string;
}

export function ScreenshotFrame({ src, alt, className }: ScreenshotFrameProps) {
  const [open, setOpen] = useState(false);

  // Close on Escape + lock body scroll while the lightbox is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Enlarge screenshot: ${alt}`}
        onClick={() => setOpen(true)}
        onKeyDown={onTriggerKey}
        className={clsx(
          'group relative block w-full cursor-zoom-in overflow-hidden rounded-xl border border-zinc-200 bg-white text-left shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          className,
        )}
      >
        <div className="flex items-center gap-1.5 border-b border-zinc-200 bg-zinc-100 px-4 py-2.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-400" />
          <div className="ml-3 flex-1 rounded-md bg-zinc-200/70 px-3 py-1 text-center text-[11px] text-zinc-400">
            bigbluebam.app
          </div>
        </div>
        <div className="relative">
          <img src={src} alt={alt} className="block w-full" loading="lazy" />
          {/* Hover affordance — discoverable hint that the shot enlarges. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-900/0 opacity-0 transition duration-200 group-hover:bg-zinc-900/10 group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
              <Maximize2 className="h-3.5 w-3.5" />
              Click to enlarge
            </span>
          </div>
        </div>
      </div>

      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[200] flex cursor-zoom-out items-center justify-center bg-black/85 p-4 backdrop-blur-sm sm:p-8"
          >
            <img
              src={src}
              alt={alt}
              className="max-h-full max-w-full rounded-lg shadow-2xl ring-1 ring-white/10"
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
