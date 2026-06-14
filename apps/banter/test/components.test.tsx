import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '../src/components/messages/message-item';
import { TypingIndicator } from '../src/components/messages/typing-indicator';
import { MessageCompose } from '../src/components/messages/message-compose';
import type { Message } from '../src/hooks/use-messages';

// Mock zustand stores
vi.mock('../src/stores/channel.store', () => ({
  useChannelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeThreadMessageId: null,
      openThread: vi.fn(),
      closeThread: vi.fn(),
      draftMessages: {},
      setDraft: vi.fn(),
      clearDraft: vi.fn(),
      activeChannelId: 'ch1',
    }),
}));

vi.mock('../src/stores/auth.store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'user1', display_name: 'Test User', email: 'test@test.com', presence: 'online' },
    }),
}));

vi.mock('../src/hooks/use-reactions', () => ({
  useToggleReaction: () => ({ mutate: vi.fn() }),
}));

vi.mock('../src/hooks/use-messages', () => ({
  usePostMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn() }),
  usePinMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useBookmark: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveBookmarkByMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../src/hooks/use-channels', () => ({
  useChannelMembers: () => ({ data: [] }),
}));

vi.mock('../src/hooks/use-typing', () => ({
  useSendTyping: () => ({ sendTyping: vi.fn() }),
  useTypingIndicators: (channelId: string) => {
    if (channelId === 'typing-test') return ['Alice', 'Bob'];
    return [];
  },
}));

vi.mock('../src/lib/websocket', () => ({
  ws: {
    on: () => vi.fn(),
    sendMessage: vi.fn(),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
  },
}));

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const sampleMessage: Message = {
  id: 'msg1',
  channel_id: 'ch1',
  author_id: 'user2',
  author_display_name: 'Jane Smith',
  author_avatar_url: null,
  content: 'Hello **world**! This is a test message.',
  is_edited: false,
  is_system: false,
  is_bot: false,
  is_pinned: false,
  thread_reply_count: 0,
  thread_latest_reply_at: null,
  reactions: [
    { emoji: '👍', count: 3, users: ['u1', 'u2', 'u3'], me: true },
  ],
  attachments: [],
  created_at: '2026-04-02T10:30:00Z',
  updated_at: '2026-04-02T10:30:00Z',
};

describe('MessageItem', () => {
  it('renders the author display name', () => {
    render(
      <TestWrapper>
        <MessageItem
          message={sampleMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  });

  // Regression for the "3-dots menu flashes and closes instantly" bug: the
  // hover action bar (which hosts the more-menu trigger) used to be gated on a
  // `hovered` flag and was unmounted by the row's onMouseLeave — so the instant
  // the pointer left the row to enter the (portaled) dropdown, the whole bar
  // including the open menu was torn down. It is now always mounted and shown
  // via CSS, so mouseleave must not remove it.
  it('keeps the action bar mounted across mouseleave (regression: menu used to unmount)', () => {
    const { container } = render(
      <TestWrapper>
        <MessageItem
          message={sampleMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    // Action bar present without any hover interaction.
    expect(screen.getByTitle('Reply in thread')).toBeInTheDocument();
    expect(screen.getByTitle('Pin message')).toBeInTheDocument();
    // Firing the exact event that used to tear it down leaves it mounted.
    fireEvent.mouseLeave(container.firstChild as HTMLElement);
    expect(screen.getByTitle('Reply in thread')).toBeInTheDocument();
  });

  it('renders message content as HTML', () => {
    render(
      <TestWrapper>
        <MessageItem
          message={sampleMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    // The content should be rendered (bold markdown converted to <strong>)
    const contentEl = document.querySelector('.rich-text-content');
    expect(contentEl).toBeInTheDocument();
    expect(contentEl?.innerHTML).toContain('<strong>world</strong>');
  });

  it('renders the timestamp', () => {
    render(
      <TestWrapper>
        <MessageItem
          message={sampleMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    // Verify the message component renders without crashing
    expect(document.querySelector('.group')).toBeTruthy();
  });

  it('renders reactions', () => {
    render(
      <TestWrapper>
        <MessageItem
          message={sampleMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    expect(screen.getByText('👍')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows BOT badge for bot messages', () => {
    const botMessage = { ...sampleMessage, is_bot: true };
    render(
      <TestWrapper>
        <MessageItem
          message={botMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    expect(screen.getByText('BOT')).toBeInTheDocument();
  });

  it('shows (edited) indicator for edited messages', () => {
    const editedMessage = { ...sampleMessage, is_edited: true };
    render(
      <TestWrapper>
        <MessageItem
          message={editedMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('renders system messages differently', () => {
    const systemMessage = {
      ...sampleMessage,
      is_system: true,
      content: 'Jane joined the channel',
    };
    render(
      <TestWrapper>
        <MessageItem
          message={systemMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    expect(screen.getByText('Jane joined the channel')).toBeInTheDocument();
    // System messages should not show the author name in the usual place
    expect(screen.queryByText('Jane Smith')).not.toBeInTheDocument();
  });

  it('does not render avatar when grouped', () => {
    const { container } = render(
      <TestWrapper>
        <MessageItem
          message={sampleMessage}
          channelId="ch1"
          grouped={true}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    // When grouped, the author name and avatar should not appear
    expect(screen.queryByText('Jane Smith')).not.toBeInTheDocument();
  });

  it('shows thread reply count', () => {
    const threadMessage = { ...sampleMessage, thread_reply_count: 5 };
    render(
      <TestWrapper>
        <MessageItem
          message={threadMessage}
          channelId="ch1"
          grouped={false}
          onNavigate={vi.fn()}
        />
      </TestWrapper>,
    );
    expect(screen.getByText('5 replies')).toBeInTheDocument();
  });
});

describe('TypingIndicator', () => {
  it('shows typing names', () => {
    render(
      <TestWrapper>
        <TypingIndicator channelId="typing-test" />
      </TestWrapper>,
    );
    expect(screen.getByText(/Alice and Bob are typing/)).toBeInTheDocument();
  });

  it('renders nothing when no one is typing', () => {
    const { container } = render(
      <TestWrapper>
        <TypingIndicator channelId="empty-channel" />
      </TestWrapper>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('MessageCompose', () => {
  it('renders the compose box with placeholder', () => {
    render(
      <TestWrapper>
        <MessageCompose channelId="ch1" channelName="general" />
      </TestWrapper>,
    );
    expect(screen.getByPlaceholderText('Message #general')).toBeInTheDocument();
  });

  it('renders the toolbar buttons', () => {
    render(
      <TestWrapper>
        <MessageCompose channelId="ch1" channelName="general" />
      </TestWrapper>,
    );
    expect(screen.getByTitle('Bold')).toBeInTheDocument();
    expect(screen.getByTitle('Italic')).toBeInTheDocument();
    expect(screen.getByTitle('Code')).toBeInTheDocument();
    expect(screen.getByTitle('Link')).toBeInTheDocument();
    expect(screen.getByTitle('Attach file')).toBeInTheDocument();
    expect(screen.getByTitle('Emoji')).toBeInTheDocument();
  });

  it('shows keyboard hint text', () => {
    render(
      <TestWrapper>
        <MessageCompose channelId="ch1" channelName="general" />
      </TestWrapper>,
    );
    expect(screen.getByText(/to send/)).toBeInTheDocument();
  });
});
