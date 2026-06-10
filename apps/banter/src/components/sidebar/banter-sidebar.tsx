import { useEffect, useState } from 'react';
import {
  Hash,
  ChevronDown,
  ChevronRight,
  Plus,
  Bookmark,
  Settings,
  Compass,
  MessageCircle,
  X,
  MoreHorizontal,
  Pencil,
  LogOut,
  Trash2,
  Phone,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import { useCan } from '@bigbluebam/ui/use-can';
import { useChannels, useCreateChannel, channelDisplayName, type Channel } from '@/hooks/use-channels';
import { useAuthStore } from '@/stores/auth.store';
import { useChannelStore } from '@/stores/channel.store';
import { cn, generateAvatarInitials, presenceColor } from '@/lib/utils';
import { api } from '@/lib/api';

interface BanterSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: { page: string; slug?: string; id?: string };
}

export function BanterSidebar({ onNavigate, activeRoute }: BanterSidebarProps) {
  const user = useAuthStore((s) => s.user);
  const unreadCounts = useChannelStore((s) => s.unreadCounts);
  const { data: channels } = useChannels();
  // Org admins (or anyone with the explicit permission) see the calling
  // settings entry. Permission matches the API gate on PATCH /v1/admin/settings.
  const canEditCallingSettings = useCan('banter.admin_setting.update');

  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [orgMembers, setOrgMembers] = useState<{ id: string; display_name: string; avatar_url: string | null }[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const createChannel = useCreateChannel();

  const regularChannels = channels?.filter((c) => c.type === 'public' || c.type === 'private') ?? [];
  const dmChannels = channels?.filter((c) => c.type === 'dm' || c.type === 'group_dm') ?? [];

  // Load org members for DM list when the DMs section opens. This used to
  // run setState + fetch directly in the render body — a side effect during
  // render that React 19 + iPad Safari handled inconsistently and could
  // contribute to the black-screen-on-mount symptom. Move into an effect.
  useEffect(() => {
    if (!dmsOpen || membersLoaded) return;
    let cancelled = false;
    setMembersLoaded(true);
    (async () => {
      try {
        const res = await fetch('/b3/api/org/members', { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const j = await res.json();
        if (cancelled || !j?.data) return;
        setOrgMembers(j.data.filter((m: { id: string }) => m.id !== user?.id));
      } catch {
        // swallow — sidebar still renders without the DM-people roster
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dmsOpen, membersLoaded, user?.id]);

  const handleCreateChannel = () => {
    const name = newChannelName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name) return;
    createChannel.mutate({ name }, {
      onSuccess: (ch) => {
        setShowCreateChannel(false);
        setNewChannelName('');
        onNavigate(`/channels/${ch.slug || name}`);
      },
    });
  };

  const handleStartDM = async (userId: string) => {
    try {
      const res = await api.post<{ data: any }>('/dm', { user_id: userId });
      const dm = res.data;
      onNavigate(`/dm/${dm.id}`);
    } catch {}
  };

  const isActive = (slug: string, type: 'channel' | 'dm') => {
    if (type === 'channel') return activeRoute.page === 'channel' && activeRoute.slug === slug;
    return activeRoute.page === 'dm' && activeRoute.id === slug;
  };

  return (
    <div className="flex flex-col h-full text-zinc-300">
      {/* Header: logo + wordmark + beta pill */}
      <button
        onClick={() => onNavigate('/')}
        className="flex items-center gap-2 px-4 py-4 border-b border-zinc-800 flex-shrink-0 hover:bg-sidebar-hover/40 transition-colors text-left"
      >
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white flex-shrink-0">
          <MessageCircle className="h-4 w-4" />
        </div>
        <span className="font-semibold text-white text-lg">Banter</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded px-1.5 py-0.5">
          beta
        </span>
      </button>

      {/* Quick actions */}
      <div className="px-3 pt-2 pb-1 space-y-0.5">
        <SidebarButton
          icon={<Bookmark className="h-4 w-4" />}
          label="Bookmarks"
          active={activeRoute.page === 'bookmarks'}
          onClick={() => onNavigate('/bookmarks')}
        />
        <SidebarButton
          icon={<Compass className="h-4 w-4" />}
          label="Browse channels"
          active={activeRoute.page === 'browse'}
          onClick={() => onNavigate('/browse')}
        />
        {canEditCallingSettings && (
          <SidebarButton
            icon={<Phone className="h-4 w-4" />}
            label="Calling settings"
            active={activeRoute.page === 'admin-calling'}
            onClick={() => onNavigate('/admin/calling')}
          />
        )}
      </div>

      {/* Scrollable channel/DM list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-3">
        {/* Channels section */}
        <div className="mt-3">
          <button
            onClick={() => setChannelsOpen(!channelsOpen)}
            className="flex items-center gap-1 px-2 py-1 w-full text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {channelsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Channels
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowCreateChannel(true);
              }}
              className="ml-auto p-0.5 rounded hover:bg-sidebar-hover"
              title="Create channel"
            >
              <Plus className="h-3 w-3" />
            </button>
          </button>

          {showCreateChannel && (
            <div className="mx-2 mb-1 p-2 rounded-md bg-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-400">New Channel</span>
                <button onClick={() => setShowCreateChannel(false)} className="text-zinc-500 hover:text-zinc-300">
                  <X className="h-3 w-3" />
                </button>
              </div>
              <input
                type="text"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateChannel(); if (e.key === 'Escape') setShowCreateChannel(false); }}
                placeholder="channel-name"
                autoFocus
                className="w-full px-2 py-1 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
              <button
                onClick={handleCreateChannel}
                disabled={!newChannelName.trim()}
                className="w-full px-2 py-1 text-xs font-medium bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                Create
              </button>
            </div>
          )}

          {channelsOpen && (
            <div className="space-y-0.5 mt-0.5">
              {regularChannels.length === 0 && (
                <p className="px-2 py-1 text-xs text-zinc-600 italic">No channels yet</p>
              )}
              {regularChannels.map((channel) => (
                <ChannelItem
                  key={channel.id}
                  channel={channel}
                  active={isActive(channel.slug, 'channel')}
                  unread={unreadCounts[channel.id]}
                  onClick={() => onNavigate(`/channels/${channel.slug}`)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          )}
        </div>

        {/* Direct Messages section */}
        <div className="mt-4 mb-2">
          <button
            onClick={() => setDmsOpen(!dmsOpen)}
            className="flex items-center gap-1 px-2 py-1 w-full text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {dmsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Direct Messages
          </button>

          {dmsOpen && (
            <div className="space-y-0.5 mt-0.5">
              {dmChannels.map((channel) => (
                <DmItem
                  key={channel.id}
                  channel={channel}
                  active={isActive(channel.id, 'dm')}
                  unread={unreadCounts[channel.id]}
                  onClick={() => onNavigate(`/dm/${channel.id}`)}
                />
              ))}
              {/* Show org members for starting DMs — dedup against the
                  existing DM channels by the OTHER participant's user id,
                  since channel.name is an unreliable fallback label. */}
              {orgMembers.filter(m =>
                !dmChannels.some(d => d.dm_other_participant?.id === m.id)
              ).map((member) => (
                <button
                  key={member.id}
                  onClick={() => handleStartDM(member.id)}
                  className="flex items-center gap-2 w-full px-2 py-1 rounded-md text-sm text-zinc-500 hover:bg-sidebar-hover hover:text-zinc-300 transition-colors"
                >
                  <div className="relative flex-shrink-0">
                    <div className="h-5 w-5 rounded-md bg-zinc-700 flex items-center justify-center text-[10px] font-medium text-zinc-300">
                      {generateAvatarInitials(member.display_name)}
                    </div>
                  </div>
                  <span className="truncate">{member.display_name}</span>
                </button>
              ))}
              {orgMembers.length === 0 && dmChannels.length === 0 && (
                <p className="px-2 py-1 text-xs text-zinc-600 italic">No team members found</p>
              )}
            </div>
          )}
        </div>
      </div>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────

function SidebarButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm transition-colors',
        active
          ? 'bg-sidebar-active text-white'
          : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ChannelItem({
  channel,
  active,
  unread,
  onClick,
  onNavigate,
}: {
  channel: Channel;
  active: boolean;
  unread?: { messages: number; mentions: number };
  onClick: () => void;
  onNavigate: (path: string) => void;
}) {
  const hasUnread = unread && unread.messages > 0;
  const hasMentions = unread && unread.mentions > 0;
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState(channel.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleRename = async () => {
    const trimmed = renameTo.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trimmed || trimmed === channel.name) {
      setRenaming(false);
      return;
    }
    try {
      await api.patch(`/channels/${channel.id}`, { name: trimmed });
      setRenaming(false);
    } catch {
      // stay in edit mode on failure
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/channels/${channel.id}`);
      onNavigate('/channels/general');
    } catch {}
  };

  const handleLeave = async () => {
    try {
      await api.post(`/channels/${channel.id}/leave`);
    } catch {}
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-1 px-2 py-0.5">
        <Hash className="h-4 w-4 flex-shrink-0 opacity-60 text-zinc-400" />
        <input
          autoFocus
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={handleRename}
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-sm text-zinc-200 outline-none focus:border-primary-500"
        />
      </div>
    );
  }

  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className={cn(
          'flex items-center gap-2 w-full px-2 py-1 rounded-md text-sm transition-colors',
          active
            ? 'bg-sidebar-active text-white'
            : hasUnread
              ? 'text-white hover:bg-sidebar-hover'
              : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
        )}
      >
        <Hash className="h-4 w-4 flex-shrink-0 opacity-60" />
        <span className={cn('truncate', hasUnread && !active && 'font-semibold')}>
          {channel.name}
        </span>
        {hasMentions && (
          <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-5 px-1 flex items-center justify-center group-hover:hidden">
            {unread.mentions}
          </span>
        )}
        {hasUnread && !hasMentions && (
          <span className="ml-auto h-2 w-2 rounded-full bg-zinc-400 group-hover:hidden" />
        )}
      </button>

      {/* Context menu trigger — always mounted so the portaled Content
          isn't unmounted mid-interaction. The trigger button itself is
          hidden by default and revealed on row hover via Tailwind's
          `group-hover:` variant, or whenever Radix has marked it
          `data-state="open"`. Closing the menu also resets the delete
          confirmation state (wired in onOpenChange). */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <DropdownMenu.Root onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
          <DropdownMenu.Trigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-0.5 rounded hover:bg-sidebar-active/50 text-zinc-500 hover:text-zinc-300 transition-colors opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 focus:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-800 shadow-lg p-1 z-50"
              sideOffset={4}
              align="start"
            >
              <DropdownMenu.Item
                className="flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md cursor-pointer hover:bg-zinc-700 text-zinc-300 outline-none"
                onClick={() => { setRenameTo(channel.name); setRenaming(true); }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md cursor-pointer hover:bg-zinc-700 text-zinc-300 outline-none"
                onClick={onClick}
              >
                <Settings className="h-3.5 w-3.5" />
                Channel settings
              </DropdownMenu.Item>
              {!channel.is_default && (
                <>
                  <DropdownMenu.Separator className="h-px bg-zinc-700 my-1" />
                  <DropdownMenu.Item
                    className="flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md cursor-pointer hover:bg-zinc-700 text-zinc-300 outline-none"
                    onClick={handleLeave}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Leave channel
                  </DropdownMenu.Item>
                  {!confirmDelete ? (
                    <DropdownMenu.Item
                      className="flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md cursor-pointer hover:bg-red-900/30 text-red-400 outline-none"
                      onClick={(e) => { e.preventDefault(); setConfirmDelete(true); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete channel
                    </DropdownMenu.Item>
                  ) : (
                    <DropdownMenu.Item
                      className="flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md cursor-pointer bg-red-900/30 text-red-300 outline-none"
                      onClick={handleDelete}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Click again to confirm
                    </DropdownMenu.Item>
                  )}
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}

function DmItem({
  channel,
  active,
  unread,
  onClick,
}: {
  channel: Channel;
  active: boolean;
  unread?: { messages: number; mentions: number };
  onClick: () => void;
}) {
  const hasUnread = unread && unread.messages > 0;

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-2 py-1 rounded-md text-sm transition-colors',
        active
          ? 'bg-sidebar-active text-white'
          : hasUnread
            ? 'text-white hover:bg-sidebar-hover'
            : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
      )}
    >
      <div className="relative flex-shrink-0">
        <div className="h-5 w-5 rounded-md bg-zinc-600 flex items-center justify-center text-[10px] font-medium text-zinc-200">
          {generateAvatarInitials(channelDisplayName(channel))}
        </div>
        {/* Presence dot derived from the counterparty's users.last_seen_at —
            online < 5min, idle < 30min, offline otherwise. Non-DM channels
            don't have a counterparty so the dot is suppressed. */}
        {channel.dm_other_participant && (
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-sidebar',
              presenceColor(channel.dm_other_participant.presence),
            )}
          />
        )}
      </div>
      <span className={cn('truncate', hasUnread && !active && 'font-semibold')}>
        {channelDisplayName(channel)}
      </span>
      {hasUnread && (
        <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-5 px-1 flex items-center justify-center">
          {unread!.messages}
        </span>
      )}
    </button>
  );
}
