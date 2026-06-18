import {
  DollarSign,
  ArrowRight,
  FileText,
  CreditCard,
  Receipt,
  RefreshCw,
  Gauge,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: FileText,
    title: 'Invoices, Start to Finish',
    description:
      'Build a draft with line items, tax, and discounts, then finalize to lock it and assign a permanent number. Every invoice exports to a clean PDF on demand, and a public link lets a client view it without an account.',
    color: 'bg-green-100 text-green-600',
  },
  {
    icon: RefreshCw,
    title: 'Recurring Billing',
    description:
      'Put standing fees on autopilot. Schedules bill a client weekly, monthly, quarterly, or annually from a saved template, auto-finalized or left as drafts to review, with pause, resume, and generate-now in reach.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: CreditCard,
    title: 'Payments & Aging',
    description:
      'Record receipts by method and date and watch each invoice move from sent to partially paid to paid. Overdue is computed from the due date, so the past-due list is always honest.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: Receipt,
    title: 'Expenses & Rates',
    description:
      'Log project costs with a category, vendor, and billable flag through a pending → approved review. Hourly, daily, or fixed rates resolve most-specific-wins, so tracked Bam time prices itself.',
    color: 'bg-green-100 text-green-600',
  },
  {
    icon: Gauge,
    title: 'Revenue & Profitability',
    description:
      'Revenue by month, outstanding aging, and per-project profitability in one place. Pull a won Bond deal or a range of Bam time entries straight into a draft, no re-keying.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Bot,
    title: 'AI Billing Operations',
    description:
      '47 MCP tools let AI agents draft invoices from deals or time entries, record payments, run a recurring schedule, and surface overdue, revenue, and profitability. Try bill_create_invoice_from_deal, bill_record_payment, and bill_get_profitability.',
    color: 'bg-teal-100 text-teal-600',
  },
];

export function BillSection() {
  return (
    <SectionWrapper id="bill" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            Invoicing
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Billing without the retype
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Billing usually means re-keying tracked time into yet another app, hoping you caught every
            line, then chasing the payment for a month. Bill skips the retype: it turns a won Bond deal
            into a draft invoice and a range of logged Bam time into priced line items, on the same
            stack: line items, expenses, recurring billing, PDFs, and honest payment and aging. And
            with 47 MCP tools, an AI agent can draft and send the whole lifecycle alongside you.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bill/light/01-dashboard.png"
          alt="Bill dashboard with outstanding, paid, overdue, and draft totals"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          Outstanding, paid, overdue, and drafts: the four numbers you actually open the app to see.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/bill/light/03-invoice-detail.png"
            alt="Bill invoice detail with line items, totals, and payment history"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            One invoice, fully assembled: line items, tax, totals, and every payment against it.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/bill/light/07-recurring.png"
            alt="Bill recurring billing schedules with cadence and next run date"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Standing fees that bill themselves on a cadence: set it once, stop chasing it.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/bill/light/05-expenses.png"
            alt="Bill expenses list with category, vendor, and approval status"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Project costs with a category, a vendor, and an approval step before anyone gets reimbursed.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.3} withScale>
          <FloatingFrame
            src="/screenshots/bill/light/06-reports.png"
            alt="Bill financial reports: revenue by month, aging, and profitability"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Revenue, aging, and profitability: the answers, without exporting to a spreadsheet first.
          </p>
        </AnimatedReveal>
      </div>

      {/* Feature highlights */}
      <AnimatedReveal delay={0.2}>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${feature.color}`}>
                <feature.icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900">{feature.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.3}>
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-green-50 to-emerald-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <DollarSign className="h-6 w-6 text-green-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bill/</code>, a
              dedicated SPA sharing authentication and the client model with Bond and Bench.
            </p>
          </div>
          <Button href="/bill/" variant="primary" size="sm">
            Try Bill <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
