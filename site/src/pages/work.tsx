import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { FeaturesOverview } from '@/components/sections/features-overview';
import { KanbanShowcase } from '@/components/sections/kanban-showcase';
import { ViewsShowcase } from '@/components/sections/views-showcase';
import { SprintSection } from '@/components/sections/sprint-section';
import { Collaboration } from '@/components/sections/collaboration';
import { UserManagement } from '@/components/sections/user-management';
import { PowerFeatures } from '@/components/sections/power-features';
import { Integrations } from '@/components/sections/integrations';
import { BoardSection } from '@/components/sections/board-section';
import { BlueprintSection } from '@/components/sections/blueprint-section';
import { BearingSection } from '@/components/sections/bearing-section';
import { Button } from '@/components/ui/button';

export function WorkPage() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 py-20 md:py-28">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.15)_0%,_transparent_60%)]" />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <a
                href="/"
                className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-blue-200 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to all products
              </a>
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Work Management
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-blue-100">
                The plan lives in one tool, the work in another, and the status update in a third,
                so nobody quite trusts any of them. Here it's one workflow on one stack: Bam's boards
                and sprints, Board's infinite canvas, Blueprint's flowcharts and org charts, and
                Bearing's goals. The brainstorm becomes a board, the board rolls up to the goal, and
                an agent can move the whole thing along while you're in a meeting. No re-keying, no
                "which tool was that in."
              </p>
            </motion.div>
          </div>
        </section>

        <FeaturesOverview />
        <KanbanShowcase />
        <ViewsShowcase />
        <SprintSection />
        <Collaboration />
        <UserManagement />
        <PowerFeatures />
        <Integrations />
        <BoardSection />
        <BlueprintSection />
        <BearingSection />

        {/* Bottom CTA */}
        <section className="border-t border-zinc-200 bg-zinc-50 py-16">
          <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-zinc-900">Ready to get started?</h2>
            <p className="max-w-lg text-zinc-600">
              Deploy the entire BigBlueBam suite -- including Bam, Board, Blueprint, and Bearing -- with a
              single Docker Compose command.
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
