import { motion } from 'motion/react';
import { ArrowLeft, Rocket } from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { BlipSection } from '@/components/sections/blip-section';
import { Button } from '@/components/ui/button';

export default function TelemetryPage() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-sky-600 via-cyan-700 to-teal-800 py-20 md:py-28">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.15)_0%,_transparent_60%)]" />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <a
                href="/"
                className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-cyan-200 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to all products
              </a>
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Telemetry & Observability
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-cyan-100">
                Observability vendors will happily rent you a dashboard that charges by the gigabyte
                and still can't tell you why anything happened. Different here: Blip is telemetry that
                lives on the same stack as the work it measures -- events ingested, partitioned, and
                indexed alongside your tasks, deals, and tickets -- so a watch can fire, a timelapse
                can replay the trend, and an agent can read the signal instead of screenshotting a
                graph.
              </p>
            </motion.div>
          </div>
        </section>

        <BlipSection />

        {/* Bottom CTA */}
        <section className="border-t border-zinc-200 bg-zinc-50 py-16">
          <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-zinc-900">Ready to get started?</h2>
            <p className="max-w-lg text-zinc-600">
              Deploy the entire BigBlueBam suite -- including Blip -- with a single Docker Compose
              command.
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
