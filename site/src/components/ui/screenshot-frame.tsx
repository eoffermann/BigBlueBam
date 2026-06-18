import { useState, useEffect, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, MoonStar } from 'lucide-react';
import clsx from 'clsx';

interface ScreenshotFrameProps {
  src: string;
  alt: string;
  className?: string;
}

/**
 * A browser-chrome framed screenshot. Two things make it more than an <img>:
 *
 *  1. Light → dark on hover/touch. The marketing shots are captured in both
 *     themes; this frame shows the light capture by default and crossfades to
 *     the dark counterpart (same path with /light/ → /dark/) whenever the
 *     pointer is over it (or a finger is touching it). The whole point is that
 *     anyone glancing at the site immediately learns BigBlueBam isn't
 *     light-mode-only. Falls back to staying light if no dark capture exists.
 *  2. Click to enlarge. Opens a full-screen lightbox (Escape or click to
 *     dismiss) that carries the same light→dark-on-hover behaviour.
 */
export function ScreenshotFrame({ src, alt, className }: ScreenshotFrameProps) {
  const darkSrc = src.replace('/light/', '/dark/');
  const hasDark = darkSrc !== src;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false); // inline: pointer/touch over the frame
  const [zoomHover, setZoomHover] = useState(false); // lightbox: pointer/touch over the image
  const [darkOk, setDarkOk] = useState(true); // dark capture loaded without 404

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

  const showDark = hasDark && darkOk;
  const darkImg = (visible: boolean) =>
    showDark ? (
      <img
        src={darkSrc}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setDarkOk(false)}
        className={clsx(
          'absolute inset-0 block h-full w-full object-cover transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      />
    ) : null;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Enlarge screenshot: ${alt}`}
        onClick={() => setOpen(true)}
        onKeyDown={onTriggerKey}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onTouchStart={() => setHover(true)}
        onTouchEnd={() => setHover(false)}
        onTouchCancel={() => setHover(false)}
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
          {darkImg(hover)}
          {/* Hover affordance: enlarge + the light/dark tell. */}
          <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-3 opacity-0 transition duration-200 group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
              {showDark ? <MoonStar className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              {showDark ? 'Dark on hover · click to enlarge' : 'Click to enlarge'}
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
            <div
              className="relative max-h-full max-w-full"
              onMouseEnter={() => setZoomHover(true)}
              onMouseLeave={() => setZoomHover(false)}
              onTouchStart={() => setZoomHover(true)}
              onTouchEnd={() => setZoomHover(false)}
              onTouchCancel={() => setZoomHover(false)}
            >
              <img
                src={src}
                alt={alt}
                className="block max-h-[88vh] max-w-[95vw] rounded-lg shadow-2xl ring-1 ring-white/10"
              />
              {darkImg(zoomHover)}
            </div>
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
