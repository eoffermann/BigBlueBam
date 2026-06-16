import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search,
  Plus,
  LayoutDashboard,
  Settings,
  FolderKanban,
  User,
  UsersRound,
  ArrowRight,
} from 'lucide-react';
import type { Project } from '@bigbluebam/shared';
import { cn } from '@/lib/utils';

interface CommandAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  category: string;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  onCreateTask?: () => void;
  projects?: Project[];
  /** When true, surface a "Go to People Manager" navigation entry. */
  canManagePeople?: boolean;
}

function fuzzyMatch(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerQuery === '') return true;

  let qi = 0;
  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) {
      qi++;
    }
  }
  return qi === lowerQuery.length;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onCreateTask,
  projects = [],
  canManagePeople = false,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const actions: CommandAction[] = useMemo(() => {
    const items: CommandAction[] = [
      {
        id: 'create-task',
        label: 'Create Task',
        icon: <Plus className="h-4 w-4" />,
        category: 'Actions',
        onSelect: () => {
          onOpenChange(false);
          onCreateTask?.();
        },
      },
      {
        id: 'go-dashboard',
        label: 'Go to Dashboard',
        icon: <LayoutDashboard className="h-4 w-4" />,
        category: 'Navigation',
        onSelect: () => {
          onOpenChange(false);
          onNavigate('/');
        },
      },
      {
        id: 'go-my-work',
        label: 'Go to My Work',
        icon: <User className="h-4 w-4" />,
        category: 'Navigation',
        onSelect: () => {
          onOpenChange(false);
          onNavigate('/my-work');
        },
      },
      {
        id: 'go-settings',
        label: 'Go to Settings',
        icon: <Settings className="h-4 w-4" />,
        category: 'Navigation',
        onSelect: () => {
          onOpenChange(false);
          onNavigate('/settings');
        },
      },
      ...(canManagePeople
        ? [
            {
              id: 'go-people-manager',
              label: 'Go to People Manager',
              icon: <UsersRound className="h-4 w-4" />,
              category: 'Navigation',
              onSelect: () => {
                onOpenChange(false);
                onNavigate('/people-manager');
              },
            },
          ]
        : []),
      ...projects.map((project) => ({
        id: `project-${project.id}`,
        label: `Switch Project: ${project.name}`,
        icon: <FolderKanban className="h-4 w-4" />,
        category: 'Projects',
        onSelect: () => {
          onOpenChange(false);
          onNavigate(`/projects/${project.id}/board`);
        },
      })),
    ];
    return items;
  }, [onOpenChange, onNavigate, onCreateTask, projects, canManagePeople]);

  const filteredActions = useMemo(
    () => actions.filter((a) => fuzzyMatch(a.label, query)),
    [actions, query],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredActions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const action = filteredActions[selectedIndex];
        if (action) action.onSelect();
      }
    },
    [filteredActions, selectedIndex],
  );

  // Group by category
  const grouped = useMemo(() => {
    const groups: { category: string; items: (CommandAction & { globalIndex: number })[] }[] = [];
    let globalIndex = 0;
    for (const action of filteredActions) {
      let group = groups.find((g) => g.category === action.category);
      if (!group) {
        group = { category: action.category, items: [] };
        groups.push(group);
      }
      group.items.push({ ...action, globalIndex });
      globalIndex++;
    }
    return groups;
  }, [filteredActions]);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 bg-black/40 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild>
              <motion.div
                className="fixed top-[20%] left-1/2 z-50 w-full max-w-xl rounded-xl bg-white shadow-2xl border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700 overflow-hidden"
                initial={{ opacity: 0, scale: 0.95, x: '-50%' }}
                animate={{ opacity: 1, scale: 1, x: '-50%' }}
                exit={{ opacity: 0, scale: 0.95, x: '-50%' }}
                transition={{ duration: 0.12 }}
              >
                <RadixDialog.Title className="sr-only">Command Palette</RadixDialog.Title>
                <RadixDialog.Description className="sr-only">
                  Search for actions and navigate
                </RadixDialog.Description>

                <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                  <Search className="h-5 w-5 text-zinc-400 shrink-0" />
                  <input
                    ref={inputRef}
                    type="text"
                    placeholder="Type a command or search..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none"
                  />
                  <kbd className="text-xs text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-0.5">
                    esc
                  </kbd>
                </div>

                <div ref={listRef} className="max-h-80 overflow-y-auto py-2">
                  {filteredActions.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-zinc-400">
                      No results found.
                    </div>
                  ) : (
                    grouped.map((group) => (
                      <div key={group.category}>
                        <div className="px-4 py-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                          {group.category}
                        </div>
                        {group.items.map((action) => (
                          <button
                            key={action.id}
                            data-selected={action.globalIndex === selectedIndex}
                            onClick={action.onSelect}
                            onMouseEnter={() => setSelectedIndex(action.globalIndex)}
                            className={cn(
                              'flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left transition-colors',
                              action.globalIndex === selectedIndex
                                ? 'bg-primary-50 text-primary-700 dark:bg-zinc-800 dark:text-primary-400'
                                : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
                            )}
                          >
                            <span className="text-zinc-400">{action.icon}</span>
                            <span className="flex-1">{action.label}</span>
                            {action.globalIndex === selectedIndex && (
                              <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                            )}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
