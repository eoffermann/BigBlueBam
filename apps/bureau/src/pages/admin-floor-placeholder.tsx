/**
 * Placeholder admin pages. Agent B owns the real editor; this stub keeps
 * the routes valid until that work lands.
 */

import { Construction } from 'lucide-react';

export function AdminFloorListPlaceholder() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
        <Construction className="mx-auto h-10 w-10 text-zinc-400" />
        <h3 className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Floor admin coming soon
        </h3>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          The floor editor (room placement, background image, ACL) is being built
          in a parallel workstream.
        </p>
      </div>
    </div>
  );
}

export function AdminFloorEditorPlaceholder({ floorId }: { floorId: string }) {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
        <Construction className="mx-auto h-10 w-10 text-zinc-400" />
        <h3 className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Floor editor for {floorId} coming soon
        </h3>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Use PATCH /bureau/api/v1/floors/{floorId} from the API for now, or
          wait for the visual editor.
        </p>
      </div>
    </div>
  );
}
