import type { DragEvent } from 'react';
import { Zap, Filter, Play, type LucideIcon } from 'lucide-react';
import { useGraphEditorStore } from '@/stores/graph-editor.store';
import type { BoltNodeKind } from '@/types/bolt-graph';

// ─── Palette item definitions ──────────────────────────────────────────────

interface PaletteItem {
  kind: BoltNodeKind;
  label: string;
  icon: LucideIcon;
  color: {
    border: string;
    bg: string;
    bgHover: string;
    icon: string;
    label: string;
    disabled: string;
  };
}

const paletteItems: PaletteItem[] = [
  {
    kind: 'trigger',
    label: 'Trigger',
    icon: Zap,
    color: {
      border: 'border-l-blue-500',
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      bgHover: 'hover:bg-blue-100 dark:hover:bg-blue-900/30',
      icon: 'text-blue-600 dark:text-blue-400',
      label: 'text-blue-700 dark:text-blue-300',
      disabled: 'bg-zinc-100 dark:bg-zinc-800/50',
    },
  },
  {
    kind: 'condition',
    label: 'Condition',
    icon: Filter,
    color: {
      border: 'border-l-amber-500',
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      bgHover: 'hover:bg-amber-100 dark:hover:bg-amber-900/30',
      icon: 'text-amber-600 dark:text-amber-400',
      label: 'text-amber-700 dark:text-amber-300',
      disabled: 'bg-zinc-100 dark:bg-zinc-800/50',
    },
  },
  {
    kind: 'action',
    label: 'Action',
    icon: Play,
    color: {
      border: 'border-l-green-500',
      bg: 'bg-green-50 dark:bg-green-900/20',
      bgHover: 'hover:bg-green-100 dark:hover:bg-green-900/30',
      icon: 'text-green-600 dark:text-green-400',
      label: 'text-green-700 dark:text-green-300',
      disabled: 'bg-zinc-100 dark:bg-zinc-800/50',
    },
  },
];

// ─── Component ─────────────────────────────────────────────────────────────

export function NodePalette() {
  const nodes = useGraphEditorStore((s) => s.nodes);
  const addNode = useGraphEditorStore((s) => s.addNode);

  const hasTrigger = nodes.some((n) => n.data?.kind === 'trigger');

  function handleDragStart(e: DragEvent, kind: BoltNodeKind) {
    e.dataTransfer.setData('application/bolt-node-kind', kind);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleClick(kind: BoltNodeKind, index: number) {
    addNode(kind, { x: 250, y: 100 + index * 150 });
  }

  return (
    <div className="flex w-14 flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      {paletteItems.map((item, index) => {
        const isDisabled = item.kind === 'trigger' && hasTrigger;
        const Icon = item.icon;

        return (
          <div key={item.kind} className="group relative">
            <button
              type="button"
              draggable={!isDisabled}
              aria-label={`Add ${item.label} node`}
              onDragStart={(e) => {
                if (isDisabled) {
                  e.preventDefault();
                  return;
                }
                handleDragStart(e, item.kind);
              }}
              onClick={() => {
                if (!isDisabled) handleClick(item.kind, index);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isDisabled) handleClick(item.kind, index);
              }}
              disabled={isDisabled}
              className={`flex w-full flex-col items-center justify-center gap-0.5 rounded-md border-l-2 px-1 py-2 transition-colors ${
                isDisabled
                  ? `${item.color.disabled} border-l-zinc-300 dark:border-l-zinc-600 cursor-not-allowed opacity-50`
                  : `${item.color.bg} ${item.color.bgHover} ${item.color.border} cursor-grab active:cursor-grabbing`
              }`}
            >
              <Icon
                className={`h-5 w-5 ${isDisabled ? 'text-zinc-400 dark:text-zinc-500' : item.color.icon}`}
              />
              <span
                className={`text-[10px] font-medium leading-tight ${
                  isDisabled ? 'text-zinc-400 dark:text-zinc-500' : item.color.label
                }`}
              >
                {item.label}
              </span>
            </button>

            {/* Tooltip */}
            <div
              className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-xs text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100 dark:bg-zinc-700"
              role="tooltip"
            >
              {isDisabled ? 'Only one trigger allowed' : item.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
