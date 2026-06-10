import { Building2, DoorOpen, Loader2, Users } from 'lucide-react';
import { useFloorsList } from '@/hooks/use-floors';
import { cn } from '@/lib/utils';

interface FloorListPageProps {
  onNavigate: (path: string) => void;
}

export function FloorListPage({ onNavigate }: FloorListPageProps) {
  const { data, isLoading, error } = useFloorsList();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="text-sm text-red-600 dark:text-red-400">
          Failed to load floors: {(error as Error).message}
        </div>
      </div>
    );
  }

  const floors = data ?? [];

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Floors
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Pick a floor to drop in. Live occupancy shows who's around right now.
        </p>
      </div>

      {floors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <Building2 className="mx-auto h-10 w-10 text-zinc-400" />
          <h3 className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            No floors yet
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Ask an org admin to create the first floor under Admin to Floors.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {floors.map((f) => (
            <button
              key={f.id}
              onClick={() => onNavigate(`/floors/${f.id}`)}
              className={cn(
                'group text-left rounded-lg border border-zinc-200 dark:border-zinc-800',
                'bg-white dark:bg-zinc-900 hover:border-primary-500 hover:shadow-md',
                'transition-all p-5 flex flex-col gap-3',
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300">
                    <DoorOpen className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {f.name}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {f.slug}
                    </div>
                  </div>
                </div>
                {f.is_default ? (
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-primary-700 dark:text-primary-300 bg-primary-50 dark:bg-primary-900/40 rounded-full px-2 py-0.5">
                    Default
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <Users className="h-3.5 w-3.5" />
                <span>
                  {f.occupancy} {f.occupancy === 1 ? 'person' : 'people'} here now
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
