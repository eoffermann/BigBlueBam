const productLinks = [
  { label: 'Bam', href: '/work#features' },
  { label: 'Banter', href: '/communicate#banter' },
  { label: 'Bay', href: '/media#bay' },
  { label: 'Beacon', href: '/communicate#beacon' },
  { label: 'Bearing', href: '/work#bearing' },
  { label: 'Bench', href: '/operations#bench' },
  { label: 'Bill', href: '/operations#bill' },
  { label: 'Bin', href: '/media#bin' },
  { label: 'Blank', href: '/operations#blank' },
  { label: 'Blast', href: '/sales#blast' },
  { label: 'Blip', href: '/telemetry#blip' },
  { label: 'Blueprint', href: '/work#blueprint' },
  { label: 'Board', href: '/work#board' },
  { label: 'Bolt', href: '/operations#bolt' },
  { label: 'Bond', href: '/sales#bond' },
  { label: 'Book', href: '/operations#book' },
  { label: 'Brief', href: '/communicate#brief' },
  { label: 'Bureau', href: '/communicate#bureau' },
  { label: 'Helpdesk', href: '/communicate#helpdesk' },
];

const categoryLinks = [
  { label: 'Work Management', href: '/work' },
  { label: 'Communication & Knowledge', href: '/communicate' },
  { label: 'Sales & Marketing', href: '/sales' },
  { label: 'Operations & Automation', href: '/operations' },
  { label: 'Media Review & Assets', href: '/media' },
  { label: 'Telemetry & Observability', href: '/telemetry' },
  { label: 'Architecture', href: '/#architecture' },
];

const resourceLinks = [
  { label: 'Documentation', href: '/docs' },
  { label: 'Deploy Guide', href: '/deploy' },
  { label: 'GitHub', href: '#cta' },
  { label: 'API Reference', href: '#cta' },
];

export function Footer() {
  return (
    <footer className="bg-zinc-950 text-zinc-400">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div>
            <div className="mb-4 flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-sm font-bold text-white">
                B
              </div>
              <span className="text-lg font-bold text-white">BigBlueBam</span>
            </div>
            <p className="max-w-xs text-sm leading-relaxed">
              The project management suite where humans and AI agents work side by side. Kanban
              boards, sprint planning, helpdesk, knowledge base, and real-time collaboration. Self-hosted, AI-native.
            </p>
          </div>

          {/* Product */}
          <div>
            <h3 className="mb-4 text-sm font-semibold tracking-wider text-zinc-300 uppercase">
              Product
            </h3>
            <ul className="space-y-2.5">
              {productLinks.map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-sm transition-colors hover:text-white">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Categories */}
          <div>
            <h3 className="mb-4 text-sm font-semibold tracking-wider text-zinc-300 uppercase">
              Categories
            </h3>
            <ul className="space-y-2.5">
              {categoryLinks.map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-sm transition-colors hover:text-white">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="mb-4 text-sm font-semibold tracking-wider text-zinc-300 uppercase">
              Resources
            </h3>
            <ul className="space-y-2.5">
              {resourceLinks.map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-sm transition-colors hover:text-white">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-zinc-800 pt-8 text-center text-sm">
          <p>From <a href="https://www.linkedin.com/in/eddieoffermann/" target="_blank" rel="noopener noreferrer" className="text-zinc-300 hover:text-white transition-colors underline underline-offset-2">Eddie Offermann</a> and Big Blue Ceiling</p>
        </div>
      </div>
    </footer>
  );
}
