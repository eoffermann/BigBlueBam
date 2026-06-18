import {
  LayoutDashboard,
  MessageCircle,
  BookOpen,
  FileText,
  Zap,
  Target,
  PenTool,
  Handshake,
  Mail,
  BarChart3,
  Calendar,
  ClipboardList,
  DollarSign,
  Headset,
  Bot,
  ArrowRight,
  GitBranch,
  Building2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

interface Product {
  name: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  color: string;
  borderColor: string;
  anchor: string;
}

interface Category {
  title: string;
  badge: string;
  badgeVariant: 'blue' | 'purple' | 'pink' | 'orange' | 'green';
  href: string;
  products: Product[];
}

const categories: Category[] = [
  {
    title: 'Work Management',
    badge: 'Work',
    badgeVariant: 'blue',
    href: '/work',
    products: [
      {
        name: 'Bam',
        subtitle: 'Project Management',
        description: 'Kanban boards, sprints, task tracking, and team collaboration.',
        icon: LayoutDashboard,
        color: 'bg-blue-100 text-blue-600',
        borderColor: 'border-l-blue-500',
        anchor: 'bam',
      },
      {
        name: 'Board',
        subtitle: 'Whiteboards',
        description: 'Infinite canvas with real-time collaboration and audio conferencing.',
        icon: PenTool,
        color: 'bg-indigo-100 text-indigo-600',
        borderColor: 'border-l-indigo-500',
        anchor: 'board',
      },
      {
        name: 'Blueprint',
        subtitle: 'Structured Diagrams',
        description: 'Typed graph diagrams — flowcharts, org charts, ERDs, mindmaps — with ELK auto-layout and agent-buildable structure.',
        icon: GitBranch,
        color: 'bg-sky-100 text-sky-600',
        borderColor: 'border-l-sky-500',
        anchor: 'blueprint',
      },
      {
        name: 'Bearing',
        subtitle: 'Goals & OKRs',
        description: 'Goal hierarchies, key results, progress tracking, and timeline views.',
        icon: Target,
        color: 'bg-cyan-100 text-cyan-600',
        borderColor: 'border-l-cyan-500',
        anchor: 'bearing',
      },
    ],
  },
  {
    title: 'Communication & Knowledge',
    badge: 'Communicate',
    badgeVariant: 'purple',
    href: '/communicate',
    products: [
      {
        name: 'Banter',
        subtitle: 'Team Messaging',
        description: 'Channels, threads, DMs, and file sharing for your whole team.',
        icon: MessageCircle,
        color: 'bg-violet-100 text-violet-600',
        borderColor: 'border-l-violet-500',
        anchor: 'banter',
      },
      {
        name: 'Helpdesk',
        subtitle: 'Customer Support',
        description: 'Ticket management, SLA tracking, and a customer-facing portal.',
        icon: Headset,
        color: 'bg-rose-100 text-rose-600',
        borderColor: 'border-l-rose-500',
        anchor: 'helpdesk',
      },
      {
        name: 'Beacon',
        subtitle: 'Knowledge Base',
        description: 'Articles, graph explorer, semantic search, and access policies.',
        icon: BookOpen,
        color: 'bg-emerald-100 text-emerald-600',
        borderColor: 'border-l-emerald-500',
        anchor: 'beacon',
      },
      {
        name: 'Brief',
        subtitle: 'Documents',
        description: 'Collaborative rich-text editor with real-time cursors and version history.',
        icon: FileText,
        color: 'bg-amber-100 text-amber-600',
        borderColor: 'border-l-amber-500',
        anchor: 'brief',
      },
      {
        name: 'Bureau',
        subtitle: 'Virtual Office',
        description: 'A spatial floor map with rooms, presence, and knock-to-enter — drop by a desk instead of scheduling a meeting.',
        icon: Building2,
        color: 'bg-purple-100 text-purple-600',
        borderColor: 'border-l-purple-500',
        anchor: 'bureau',
      },
    ],
  },
  {
    title: 'Sales & Marketing',
    badge: 'Sales',
    badgeVariant: 'pink',
    href: '/sales',
    products: [
      {
        name: 'Bond',
        subtitle: 'CRM',
        description: 'Contacts, companies, deal pipeline, and activity logging.',
        icon: Handshake,
        color: 'bg-pink-100 text-pink-600',
        borderColor: 'border-l-pink-500',
        anchor: 'bond',
      },
      {
        name: 'Blast',
        subtitle: 'Email Campaigns',
        description: 'Templates, segments, A/B testing, and delivery analytics.',
        icon: Mail,
        color: 'bg-red-100 text-red-600',
        borderColor: 'border-l-red-500',
        anchor: 'blast',
      },
    ],
  },
  {
    title: 'Operations',
    badge: 'Ops',
    badgeVariant: 'orange',
    href: '/operations',
    products: [
      {
        name: 'Bolt',
        subtitle: 'Automations',
        description: 'Visual trigger-condition-action rules spanning every product.',
        icon: Zap,
        color: 'bg-red-100 text-red-600',
        borderColor: 'border-l-red-500',
        anchor: 'bolt',
      },
      {
        name: 'Bench',
        subtitle: 'Analytics',
        description: 'Dashboards, widgets, ad-hoc queries, and scheduled reports.',
        icon: BarChart3,
        color: 'bg-blue-100 text-blue-600',
        borderColor: 'border-l-blue-500',
        anchor: 'bench',
      },
      {
        name: 'Book',
        subtitle: 'Scheduling',
        description: 'Calendar views, resource booking, and timezone-aware events.',
        icon: Calendar,
        color: 'bg-blue-100 text-blue-600',
        borderColor: 'border-l-blue-500',
        anchor: 'book',
      },
      {
        name: 'Blank',
        subtitle: 'Forms & Surveys',
        description: 'Form builder with conditional logic and response analytics.',
        icon: ClipboardList,
        color: 'bg-violet-100 text-violet-600',
        borderColor: 'border-l-violet-500',
        anchor: 'blank',
      },
      {
        name: 'Bill',
        subtitle: 'Invoicing',
        description: 'Invoice builder, payment tracking, and recurring billing.',
        icon: DollarSign,
        color: 'bg-green-100 text-green-600',
        borderColor: 'border-l-green-500',
        anchor: 'bill',
      },
    ],
  },
];

const mcpServer: Product = {
  name: 'MCP Server',
  subtitle: '720+ AI Tools',
  description: 'One Model Context Protocol server that hands AI agents every app plus cross-cutting platform powers (search, composite views, proposals, policies, webhooks) — the front door the whole suite shares.',
  icon: Bot,
  color: 'bg-slate-100 text-slate-600',
  borderColor: 'border-l-slate-400',
  anchor: 'mcp',
};

function ProductCard({ product, href }: { product: Product; href: string }) {
  return (
    <a
      href={`${href}#${product.anchor}`}
      className={`group flex gap-4 rounded-xl border border-l-4 border-zinc-200 ${product.borderColor} bg-white p-5 shadow-sm transition-shadow hover:shadow-md`}
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${product.color}`}>
        <product.icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-zinc-900">{product.name}</h3>
          <span className="text-xs text-zinc-400">{product.subtitle}</span>
        </div>
        <p className="mt-1 text-sm text-zinc-600">{product.description}</p>
      </div>
      <ArrowRight className="ml-auto h-4 w-4 shrink-0 self-center text-zinc-300 transition-colors group-hover:text-zinc-600" />
    </a>
  );
}

export function ProductGrid() {
  return (
    <SectionWrapper id="products" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <Badge variant="blue" className="mb-4">
            16 Apps + MCP Platform, One Stack
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Everything your team needs
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Work, communication, sales, and operations — sixteen apps, all self-hosted, all wired
            together through a single MCP server with 720+ tools. No tab-switching, no integration
            spreadsheet, no app that didn't get the memo.
          </p>
        </div>
      </AnimatedReveal>

      {categories.map((category, catIdx) => (
        <AnimatedReveal key={category.title} delay={0.1 * (catIdx + 1)}>
          <div className="mb-12 last:mb-0">
            <div className="mb-4 flex items-center gap-3">
              <Badge variant={category.badgeVariant}>{category.badge}</Badge>
              <h3 className="text-xl font-bold text-zinc-900">{category.title}</h3>
              <a
                href={category.href}
                className="ml-auto flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                View all <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {category.products.map((product) => (
                <ProductCard key={product.name} product={product} href={category.href} />
              ))}
            </div>
          </div>
        </AnimatedReveal>
      ))}

      {/* MCP Server standalone */}
      <AnimatedReveal delay={0.5}>
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-6">
          <div className="flex items-center gap-4">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${mcpServer.color}`}>
              <mcpServer.icon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-zinc-900">{mcpServer.name}</h3>
                <span className="text-xs text-zinc-400">{mcpServer.subtitle}</span>
              </div>
              <p className="mt-1 text-sm text-zinc-600">{mcpServer.description}</p>
            </div>
            <a
              href="/docs"
              className="ml-auto flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              Docs <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
