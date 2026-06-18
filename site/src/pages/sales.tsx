import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { BondSection } from '@/components/sections/bond-section';
import { BlastSection } from '@/components/sections/blast-section';
import { Button } from '@/components/ui/button';

export function SalesPage() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-pink-600 via-rose-700 to-red-800 py-20 md:py-28">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.15)_0%,_transparent_60%)]" />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <a
                href="/"
                className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-pink-200 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to all products
              </a>
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Sales & Marketing
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-pink-100">
                The CRM nobody updates because it lives a continent away from the actual work, plus a
                won deal that closes to silence, with the kickoff and the invoice still on someone's
                to-do list. Bond's visual pipeline and Blast's email campaigns sit on the same stack
                as your projects, so a won deal can spin up a Bam project and a Bill invoice on its
                own, and an agent can log the call you forgot to. Contacts, deals, segments, and
                analytics, connected to where the work happens, not stranded beside it.
              </p>
            </motion.div>
          </div>
        </section>

        <BondSection />
        <BlastSection />

        {/* Bottom CTA */}
        <section className="border-t border-zinc-200 bg-zinc-50 py-16">
          <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-zinc-900">Ready to get started?</h2>
            <p className="max-w-lg text-zinc-600">
              Deploy the entire BigBlueBam suite -- including Bond CRM and Blast email campaigns --
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
