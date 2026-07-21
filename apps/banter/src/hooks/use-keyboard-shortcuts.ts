import { useEffect, useCallback, useState } from 'react';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { useChannelStore } from '@/stores/channel.store';

/**
 * Global keyboard shortcuts for Banter.
 *
 * - Ctrl+K / Cmd+K: Open quick channel switcher
 * - Ctrl+Shift+M / Cmd+Shift+M: Toggle mute (when in call)
 * - Escape: Close thread panel
 * - Up arrow in empty compose: Edit last message
 */
export function useKeyboardShortcuts() {
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const closeThread = useChannelStore((s) => s.closeThread);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isModifier = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // Ctrl+K / Cmd+K: Quick channel switcher
      if (isModifier && e.key === 'k') {
        e.preventDefault();
        setQuickSwitcherOpen((prev) => !prev);

        // Dispatch a custom event that the sidebar/quick-switcher can listen to
        window.dispatchEvent(new CustomEvent('banter:quick-switcher', { detail: { open: true } }));
        return;
      }

      // Ctrl+Shift+M / Cmd+Shift+M: Toggle mute
      if (isModifier && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('banter:toggle-mute'));
        return;
      }

      // Escape: Close thread panel (only when not in an input)
      if (e.key === 'Escape') {
        // Close quick switcher first if it's open
        if (quickSwitcherOpen) {
          setQuickSwitcherOpen(false);
          window.dispatchEvent(new CustomEvent('banter:quick-switcher', { detail: { open: false } }));
          return;
        }

        // Close thread panel
        if (closeThread) {
          closeThread();
        }
        return;
      }

      // ? key: Open Help
      if (e.key === '?' && !isInInput && !isModifier) {
        e.preventDefault();
        openHelpCenter('banter');
        return;
      }

      // Up arrow in empty compose: Edit last message
      if (e.key === 'ArrowUp' && isInInput) {
        const textarea = target as HTMLTextAreaElement;
        if (textarea.tagName === 'TEXTAREA' && textarea.value === '') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('banter:edit-last-message'));
        }
        return;
      }
    },
    [closeThread, quickSwitcherOpen],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return { quickSwitcherOpen, setQuickSwitcherOpen };
}
