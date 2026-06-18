import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { BanterStub } from '@/components/sections/banter-stub';
import { BureauSection } from '@/components/sections/bureau-section';
import { HelpdeskSection } from '@/components/sections/helpdesk-section';
import { BeaconSection } from '@/components/sections/beacon-section';
import { BriefSection } from '@/components/sections/brief-section';
import { Button } from '@/components/ui/button';

export function CommunicatePage() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-violet-600 via-purple-700 to-indigo-800 py-20 md:py-28">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.15)_0%,_transparent_60%)]" />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <a
                href="/"
                className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-purple-200 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to all products
              </a>
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Communication & Knowledge
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-purple-100">
                Team chat is where decisions go to get lost in the scrollback, and the "AI" in it
                can summarize a thread but can't actually <em>do</em> anything. Different here: Banter
                for real-time chat, Helpdesk for customer support, Beacon for a searchable knowledge
                base, and Brief for documents — all on the same stack, so a message becomes a task, a
                ticket links to the deal, and an agent in the channel can move the work, not just
                recap it.
              </p>
            </motion.div>
          </div>
        </section>

        <BanterStub />
        <BureauSection />
        <HelpdeskSection />
        <BeaconSection />
        <BriefSection />

        {/* Bottom CTA */}
        <section className="border-t border-zinc-200 bg-zinc-50 py-16">
          <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-zinc-900">Ready to get started?</h2>
            <p className="max-w-lg text-zinc-600">
              Deploy the entire BigBlueBam suite -- including Banter, Helpdesk, Beacon, and Brief --
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
