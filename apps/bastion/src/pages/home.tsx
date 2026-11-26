import { Castle } from 'lucide-react';

// M1 placeholder home page. The Readiness page (spec 6.1) replaces it at M5.
export function HomePage() {
  return (
    <div className="max-w-3xl mx-auto px-8 py-16">
      <div className="flex items-center gap-3 mb-6">
        <div className="flex items-center justify-center h-12 w-12 rounded-2xl bg-primary-600 text-white">
          <Castle className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">Bastion</h1>
      </div>
      <p className="text-lg text-zinc-700 dark:text-zinc-300 leading-relaxed">
        Every night Bastion checks your SOC 2 or ISO 27001 controls against what actually happened
        in the suite, freezes tamper-evident proof of each result, and lists first the controls
        nothing can prove, each with the cheapest fix already drafted.
      </p>
      <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
        Bastion is being set up. Your compliance checklist, evidence and readiness numbers will
        appear here.
      </p>
    </div>
  );
}
