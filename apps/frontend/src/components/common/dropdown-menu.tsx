import type { ReactNode } from 'react';
import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

interface DropdownMenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}

export function DropdownMenu({ trigger, children, align = 'end' }: DropdownMenuProps) {
  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          align={align}
          sideOffset={4}
          className={cn(
            'z-50 min-w-[180px] overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 shadow-lg',
            'dark:bg-zinc-900 dark:border-zinc-700',
            'animate-fade-in',
          )}
        >
          {children}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

interface DropdownMenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
  /** When true, the item is shown but cannot be activated. Pair with
   *  `title` to explain why so users get a tooltip instead of a dead
   *  click. */
  disabled?: boolean;
  /** Native title attribute — surfaces as a tooltip on hover. */
  title?: string;
  className?: string;
}

export function DropdownMenuItem({
  children,
  onSelect,
  destructive,
  disabled,
  title,
  className,
}: DropdownMenuItemProps) {
  return (
    <RadixDropdownMenu.Item
      disabled={disabled}
      title={title}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm outline-none',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800',
        destructive
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950'
          : 'text-zinc-700 dark:text-zinc-300',
        className,
      )}
      onSelect={disabled ? undefined : onSelect}
    >
      {children}
    </RadixDropdownMenu.Item>
  );
}

export function DropdownMenuSeparator() {
  return <RadixDropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" />;
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <RadixDropdownMenu.Label className="px-3 py-1.5 text-xs font-medium text-zinc-500">
      {children}
    </RadixDropdownMenu.Label>
  );
}
