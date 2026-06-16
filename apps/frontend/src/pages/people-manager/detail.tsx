import { ArrowLeft } from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';

interface PeopleManagerDetailPageProps {
  userId: string;
  onNavigate: (path: string) => void;
}

/**
 * People Manager v2 — person detail (plan §7, milestone M3).
 *
 * M2 ships a minimal placeholder shell so the `/people-manager/:userId`
 * route resolves and the roster's row/"View" links land somewhere coherent.
 * M3 fills this with the tabbed person view (Overview/Identity, Memberships,
 * Projects, Access, Activity) reusing the existing `/org/members/*` endpoints
 * via the `X-Org-Id` injector.
 */
export function PeopleManagerDetailPage({ userId, onNavigate }: PeopleManagerDetailPageProps) {
  return (
    <AppLayout
      breadcrumbs={[
        { label: 'People Manager', href: '/people-manager' },
        { label: 'Person' },
      ]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Person detail
          </h1>
          <Button variant="secondary" onClick={() => onNavigate('/people-manager')}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-8 text-center space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            The full person detail (identity, memberships, projects, access, activity)
            lands in milestone M3.
          </p>
          <p className="text-xs font-mono text-zinc-400">user_id: {userId}</p>
        </div>
      </div>
    </AppLayout>
  );
}
