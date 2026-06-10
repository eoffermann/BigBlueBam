import { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  Share2,
  Lock,
  Unlock,
  History,
  MessageCircle,
  MoreHorizontal,
  Image as ImageIcon,
  FileDown,
} from 'lucide-react';
import { useBoard, useUpdateBoard, useToggleLock } from '@/hooks/use-boards';
import { Button } from '@/components/common/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { IconPicker } from '@/components/common/icon-picker';
import { cn } from '@/lib/utils';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface BoardToolbarProps {
  boardId: string;
  onNavigate: (path: string) => void;
  onToggleChat: () => void;
  chatOpen: boolean;
}

export function BoardToolbar({ boardId, onNavigate, onToggleChat, chatOpen }: BoardToolbarProps) {
  const { data } = useBoard(boardId);
  const board = data?.data;
  const updateBoard = useUpdateBoard(boardId);
  const toggleLock = useToggleLock();

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  const handleNameSubmit = () => {
    if (nameValue.trim() && nameValue !== board?.name) {
      updateBoard.mutate({ name: nameValue.trim() });
    }
    setEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNameSubmit();
    if (e.key === 'Escape') setEditingName(false);
  };

  return (
    <div className="absolute top-0 left-0 right-0 z-[200] flex items-center justify-between h-12 px-3 pointer-events-none">
      {/* Left group — offset right to avoid Excalidraw's menu button */}
      <div className="flex items-center gap-2 pointer-events-auto ml-12">
        <button
          onClick={() => onNavigate('/')}
          className="flex items-center justify-center h-8 w-8 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors"
          title="Back to boards"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 px-3 py-1.5">
          <IconPicker
            value={board?.icon ?? null}
            onChange={(icon) => updateBoard.mutate({ icon })}
            triggerSize="sm"
            tone="blue"
          />

          {editingName ? (
            <input
              ref={nameInputRef}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={handleNameKeyDown}
              className="text-sm font-semibold bg-transparent border-none outline-none text-zinc-900 dark:text-zinc-100 w-48"
            />
          ) : (
            <button
              onClick={() => {
                setNameValue(board?.name ?? '');
                setEditingName(true);
              }}
              className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
            >
              {board?.name ?? 'Untitled Board'}
            </button>
          )}

          {board?.locked && (
            <Lock className="h-3.5 w-3.5 text-zinc-400" />
          )}
        </div>
      </div>

      {/* Right group */}
      <div className="flex items-center gap-2 pointer-events-auto">
        <div className="rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 px-2 py-1">
          <PresenceChipStrip
            url={`${window.location.origin}${window.location.pathname}`}
            surfaceApp="board"
            surfaceId={boardId}
            surfaceLabel={board?.name ?? 'Untitled Board'}
          />
        </div>

        <button
          onClick={onToggleChat}
          className={cn(
            'flex items-center justify-center h-8 w-8 rounded-lg backdrop-blur shadow-sm border transition-colors',
            chatOpen
              ? 'bg-primary-100 dark:bg-primary-900/40 border-primary-300 dark:border-primary-700 text-primary-600 dark:text-primary-400'
              : 'bg-white/90 dark:bg-zinc-800/90 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800',
          )}
          title="Toggle chat"
        >
          <MessageCircle className="h-4 w-4" />
        </button>

        <button
          onClick={() => onNavigate(`/${boardId}/versions`)}
          className="flex items-center justify-center h-8 w-8 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors"
          title="Version history"
        >
          <History className="h-4 w-4" />
        </button>

        <Button
          variant="secondary"
          size="sm"
          className="h-8 bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
        </Button>

        <DropdownMenu
          trigger={
            <button className="flex items-center justify-center h-8 w-8 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        >
          <DropdownMenuItem onSelect={() => toggleLock.mutate(boardId)}>
            {board?.locked ? (
              <>
                <Unlock className="h-4 w-4" />
                Unlock board
              </>
            ) : (
              <>
                <Lock className="h-4 w-4" />
                Lock board
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <ImageIcon className="h-4 w-4" />
            Export as PNG
          </DropdownMenuItem>
          <DropdownMenuItem>
            <FileDown className="h-4 w-4" />
            Export as SVG
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
    </div>
  );
}

