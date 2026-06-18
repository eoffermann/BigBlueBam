import { ArrowRight, BookOpen } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';

export function Cta() {
  return (
    <SectionWrapper id="cta" dark dividerTop className="relative overflow-hidden">
      {/* Gradient accent */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary-900/20 via-transparent to-primary-800/10" />

      <div className="relative mx-auto max-w-2xl text-center">
        <AnimatedReveal>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Put humans and AI agents on the same team
          </h2>
          <p className="mt-4 text-lg text-primary-200">
            The next decade of work runs on people and agents sharing the same boards, the same
            tickets, the same data — and we're built for exactly that. Open source, self-hosted,
            AI-native from day one. Spin it up with one command and meet your newest teammates. They
            don't need a desk, a seat license, or a tour of where things live.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button href="/b3/" variant="white" size="lg">
              Sign up to test <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              href="https://github.com/eoffermann/BigBlueBam/blob/main/README.md"
              variant="outline"
              size="lg"
              className="!border-primary-400/30 !text-zinc-200 hover:!bg-primary-900/50 hover:!text-zinc-100"
            >
              <BookOpen className="h-4 w-4" /> Read the Docs
            </Button>
          </div>
        </AnimatedReveal>
      </div>
    </SectionWrapper>
  );
}
