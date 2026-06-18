import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Github } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { HeroBlobs } from '@/components/ui/hero-blobs';

export function Hero() {
  const reduced = useReducedMotion();

  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-white via-primary-50/40 to-white pt-28 pb-20 md:pt-36 md:pb-28">
      {/* Subtle grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0,0,0,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.1) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <HeroBlobs />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={reduced ? {} : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary-200 bg-primary-50 px-4 py-1.5 text-sm font-medium text-primary-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-500" />
              Where humans and AI agents work side by side
            </div>
          </motion.div>

          <motion.h1
            initial={reduced ? {} : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl lg:text-6xl"
          >
            Sixteen apps. One stack.{' '}
            <span className="bg-gradient-to-r from-primary-600 to-primary-500 bg-clip-text text-transparent">
              Your newest hires are AI.
            </span>
          </motion.h1>

          <motion.p
            initial={reduced ? {} : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-600"
          >
            A self-hosted productivity suite — boards, chat, CRM, docs, helpdesk, and a dozen more —
            that behaves like a single product. It was built from day one so AI agents work right
            alongside your team, with the same boards, sprints, tickets, and tools as the humans.
            All sixteen apps speak to agents through one MCP server with 720+ tools, so the new hires
            never ask where anything lives.
          </motion.p>

          <motion.div
            initial={reduced ? {} : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Button href="#cta" size="lg">
              Get Started <ArrowRight className="h-4 w-4" />
            </Button>
            <Button href="https://github.com/eoffermann/BigBlueBam" variant="outline" size="lg">
              <Github className="h-4 w-4" /> View on GitHub
            </Button>
          </motion.div>
        </div>

        <motion.div
          initial={reduced ? {} : { opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="mt-16 md:mt-20"
        >
          <FloatingFrame src="/screenshots/bam/light/01-board.png" alt="Bam Kanban board" />
        </motion.div>
      </div>
    </section>
  );
}
