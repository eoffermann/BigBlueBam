import { lazy, Suspense } from 'react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { Hero } from '@/components/sections/hero';
import { AiCollaboration } from '@/components/sections/ai-collaboration';
import { PervasivePresence } from '@/components/sections/pervasive-presence';
import { ProductGrid } from '@/components/sections/product-grid';
import { Architecture } from '@/components/sections/architecture';
import { Cta } from '@/components/sections/cta';

const WorkPage = lazy(() => import('@/pages/work').then((m) => ({ default: m.WorkPage })));
const CommunicatePage = lazy(() => import('@/pages/communicate').then((m) => ({ default: m.CommunicatePage })));
const SalesPage = lazy(() => import('@/pages/sales').then((m) => ({ default: m.SalesPage })));
const OperationsPage = lazy(() => import('@/pages/operations').then((m) => ({ default: m.OperationsPage })));
const DeployGuidePage = lazy(() => import('@/pages/deploy-guide').then((m) => ({ default: m.DeployGuidePage })));
const ManualPage = lazy(() => import('@/pages/manual').then((m) => ({ default: m.ManualPage })));
const TechnicalPage = lazy(() => import('@/pages/technical').then((m) => ({ default: m.TechnicalPage })));
const MediaPage = lazy(() => import('@/pages/media'));
const TelemetryPage = lazy(() => import('@/pages/telemetry'));

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-600 border-t-transparent" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function App() {
  const path = window.location.pathname;

  if (path.startsWith('/work')) {
    return (
      <PageShell>
        <WorkPage />
      </PageShell>
    );
  }

  if (path.startsWith('/communicate')) {
    return (
      <PageShell>
        <CommunicatePage />
      </PageShell>
    );
  }

  if (path.startsWith('/sales')) {
    return (
      <PageShell>
        <SalesPage />
      </PageShell>
    );
  }

  if (path.startsWith('/operations')) {
    return (
      <PageShell>
        <OperationsPage />
      </PageShell>
    );
  }

  if (path.startsWith('/media')) {
    return (
      <PageShell>
        <MediaPage />
      </PageShell>
    );
  }

  if (path.startsWith('/telemetry')) {
    return (
      <PageShell>
        <TelemetryPage />
      </PageShell>
    );
  }

  if (path.startsWith('/deploy')) {
    return (
      <PageShell>
        <DeployGuidePage />
      </PageShell>
    );
  }

  if (path.startsWith('/docs')) {
    return (
      <PageShell>
        <ManualPage />
      </PageShell>
    );
  }

  if (path.startsWith('/technical')) {
    return (
      <PageShell>
        <TechnicalPage />
      </PageShell>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        <Hero />
        <AiCollaboration />
        <PervasivePresence />
        <ProductGrid />
        <Architecture />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
