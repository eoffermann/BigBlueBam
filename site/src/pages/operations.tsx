import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { BoltSection } from '@/components/sections/bolt-section';
import { BenchSection } from '@/components/sections/bench-section';
import { BasisSection } from '@/components/sections/basis-section';
import { BraidSection } from '@/components/sections/braid-section';
import { BulwarkSection } from '@/components/sections/bulwark-section';
import { BurnSection } from '@/components/sections/burn-section';
import { BookSection } from '@/components/sections/book-section';
import { BlankSection } from '@/components/sections/blank-section';
import { BillSection } from '@/components/sections/bill-section';
import { Button } from '@/components/ui/button';

export function OperationsPage() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-amber-600 via-orange-700 to-red-800 py-20 md:py-28">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.15)_0%,_transparent_60%)]" />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <a
                href="/"
                className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-amber-200 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to all products
              </a>
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Operations & Automation
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-amber-100">
                Invoicing, forms, scheduling, analytics, and automation: five more subscriptions that
                each live in their own corner and have never heard of your projects. Here they're
                part of the same stack: Bolt automates across every app, Bench charts data straight
                from your boards and deals, Book schedules against real calendars, Blank routes form
                responses into the work, and Bill turns tracked time and won deals into invoices.
                The back office, finally on speaking terms with the front.
              </p>
            </motion.div>
          </div>
        </section>

        <BoltSection />
        <BenchSection />
        <BasisSection />
        <BraidSection />
        <BulwarkSection />
        <BurnSection />
        <BookSection />
        <BlankSection />
        <BillSection />

        {/* Bottom CTA */}
        <section className="border-t border-zinc-200 bg-zinc-50 py-16">
          <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-zinc-900">Ready to get started?</h2>
            <p className="max-w-lg text-zinc-600">
              Deploy the entire BigBlueBam suite -- including Bolt, Bench, Book, Blank, and Bill --
              with a single Docker Compose command.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button href="/" variant="outline">
                <ArrowLeft className="h-4 w-4" /> All products
              </Button>
              <Button href="/deploy" variant="primary">
                <Rocket className="h-4 w-4" /> Deploy guide
              </Button>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
