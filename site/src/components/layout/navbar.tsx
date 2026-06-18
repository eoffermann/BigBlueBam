import { useState, useEffect, useCallback, useRef } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';

const categoryLinks = [
  { label: 'Work Management', href: '/work' },
  { label: 'Communication & Knowledge', href: '/communicate' },
  { label: 'Sales & Marketing', href: '/sales' },
  { label: 'Operations & Automation', href: '/operations' },
];

function isHomepage() {
  const p = window.location.pathname;
  return p === '/' || p === '/index.html';
}

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const currentPath = window.location.pathname;

  const openDropdown = useCallback(() => {
    clearTimeout(closeTimer.current);
    setDropdownOpen(true);
  }, []);

  const closeDropdown = useCallback(() => {
    closeTimer.current = setTimeout(() => setDropdownOpen(false), 150);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const isActive = (href: string) => currentPath.startsWith(href);
  const isProductActive = categoryLinks.some((l) => isActive(l.href));

  const aiHref = isHomepage() ? '#ai-collaboration' : '/#ai-collaboration';

  return (
    <header
      className={clsx(
        'fixed top-0 right-0 left-0 z-50 transition-all duration-300',
        scrolled
          ? 'border-b border-zinc-200/50 bg-white/80 shadow-sm backdrop-blur-lg'
          : 'bg-transparent',
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-sm font-bold text-white">
            B
          </div>
          <span className="text-lg font-bold text-zinc-900">BigBlueBam</span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {/* Products dropdown */}
          <div
            ref={dropdownRef}
            className="relative"
            onMouseEnter={openDropdown}
            onMouseLeave={closeDropdown}
          >
            <button
              type="button"
              onClick={() => setDropdownOpen((v) => !v)}
              className={clsx(
                'inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isProductActive
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-zinc-600 hover:text-zinc-900',
              )}
            >
              Products
              <ChevronDown
                className={clsx(
                  'h-3.5 w-3.5 transition-transform duration-200',
                  dropdownOpen && 'rotate-180',
                )}
              />
            </button>

            {dropdownOpen && (
              <div className="absolute left-0 top-full mt-1 w-64 rounded-xl border border-zinc-200 bg-white py-2 shadow-lg">
                {categoryLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className={clsx(
                      'block px-4 py-2.5 text-sm font-medium transition-colors',
                      isActive(link.href)
                        ? 'bg-primary-50 text-primary-700'
                        : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900',
                    )}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Human + AI */}
          <a
            href={aiHref}
            className={clsx(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              'text-zinc-600 hover:text-zinc-900',
            )}
          >
            Human + AI
          </a>

          {/* Technical deep dive */}
          <a
            href="/technical"
            className={clsx(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive('/technical')
                ? 'bg-primary-50 text-primary-700'
                : 'text-zinc-600 hover:text-zinc-900',
            )}
          >
            Talk nerdy to me
          </a>

          {/* Deploy */}
          <a
            href="/deploy"
            className={clsx(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive('/deploy')
                ? 'bg-primary-50 text-primary-700'
                : 'text-zinc-600 hover:text-zinc-900',
            )}
          >
            Deploy
          </a>

          {/* Docs */}
          <a
            href="/docs"
            className={clsx(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive('/docs')
                ? 'bg-primary-50 text-primary-700'
                : 'text-zinc-600 hover:text-zinc-900',
            )}
          >
            Docs
          </a>
        </nav>

        {/* Desktop CTA */}
        <div className="hidden items-center gap-3 md:flex">
          <Button href="/deploy" size="sm">
            Get Started
          </Button>
        </div>

        {/* Mobile menu toggle */}
        <button
          type="button"
          className="rounded-md p-2 text-zinc-600 hover:bg-zinc-100 md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="border-t border-zinc-200 bg-white px-4 pb-4 md:hidden">
          {/* Category pages */}
          <p className="mt-3 mb-1 px-3 text-xs font-semibold tracking-wider text-zinc-400 uppercase">
            Products
          </p>
          {categoryLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className={clsx(
                'block rounded-md px-3 py-2.5 text-sm font-medium',
                isActive(link.href)
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-zinc-600 hover:bg-zinc-50',
              )}
            >
              {link.label}
            </a>
          ))}

          {/* Other links */}
          <div className="mt-2 border-t border-zinc-100 pt-2">
            <a
              href={aiHref}
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
            >
              Human + AI
            </a>
            <a
              href="/technical"
              onClick={() => setMobileOpen(false)}
              className={clsx(
                'block rounded-md px-3 py-2.5 text-sm font-medium',
                isActive('/technical')
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-zinc-600 hover:bg-zinc-50',
              )}
            >
              Talk nerdy to me
            </a>
            <a
              href="/deploy"
              onClick={() => setMobileOpen(false)}
              className={clsx(
                'block rounded-md px-3 py-2.5 text-sm font-medium',
                isActive('/deploy')
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-zinc-600 hover:bg-zinc-50',
              )}
            >
              Deploy
            </a>
            <a
              href="/docs"
              onClick={() => setMobileOpen(false)}
              className={clsx(
                'block rounded-md px-3 py-2.5 text-sm font-medium',
                isActive('/docs')
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-zinc-600 hover:bg-zinc-50',
              )}
            >
              Docs
            </a>
          </div>

          <div className="mt-3 border-t border-zinc-100 pt-3">
            <Button href="/deploy" size="sm" className="w-full">
              Get Started
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
