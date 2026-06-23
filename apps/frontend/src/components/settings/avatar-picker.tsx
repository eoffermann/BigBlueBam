import { useState, useRef, useEffect } from 'react';
import { Upload, Trash2, Loader2, Images } from 'lucide-react';
import { Avatar } from '@/components/common/avatar';
import { Button } from '@/components/common/button';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

interface AvatarManifest {
  categories: { key: string; label: string; count: number }[];
  // `thumb` is a small (~6KB) 192px WebP used for both the grid and the stored
  // avatar; `url` is the full 512px PNG, kept for reference only.
  avatars: { id: string; file: string; category: string; url: string; thumb: string }[];
}

/**
 * Profile-picture chooser for the Settings > Profile tab.
 *
 * Three ways to set an avatar, all reflected immediately via the auth store so
 * the topbar and every other surface update without a refetch:
 *   - Upload a photo  -> POST /auth/me/avatar (multipart), sets avatar_url server-side.
 *   - Pick a default  -> PATCH /auth/me { avatar_url: '/avatars/<file>' }.
 *   - Remove          -> PATCH /auth/me { avatar_url: null }.
 *
 * The default options are served (and listed) by nginx at /avatars/ from the
 * bundled assets/default-avatars set, so this component works in every app's
 * deployment without bundling the images into the SPA.
 */
export function AvatarPicker() {
  const { user, patchUser } = useAuthStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);
  const [manifest, setManifest] = useState<AvatarManifest | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');

  // Lazy-load the default-avatar manifest the first time the grid is opened.
  useEffect(() => {
    if (!showDefaults || manifest) return;
    let cancelled = false;
    fetch('/avatars/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((m: AvatarManifest) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the default avatars.');
      });
    return () => {
      cancelled = true;
    };
  }, [showDefaults, manifest]);

  const setAvatar = async (avatarUrl: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch('/auth/me', { avatar_url: avatarUrl });
      patchUser({ avatar_url: avatarUrl });
    } catch {
      setError('Could not update your profile picture.');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload<{ data: { avatar_url: string } }>('/auth/me/avatar', fd);
      patchUser({ avatar_url: res.data.avatar_url });
      setShowDefaults(false);
    } catch {
      setError('Upload failed. Use a PNG, JPEG, GIF, or WebP image under 25MB.');
    } finally {
      setBusy(false);
    }
  };

  const shown =
    manifest?.avatars.filter((a) => activeCategory === 'all' || a.category === activeCategory) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Profile picture</label>
      <div className="flex items-center gap-4">
        <Avatar
          src={user?.avatar_url}
          name={user?.display_name}
          className="h-20 w-20 text-2xl ring-1 ring-zinc-200 dark:ring-zinc-700"
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={handleFile}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              loading={busy}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload photo
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowDefaults((v) => !v)}
              disabled={busy}
            >
              <Images className="h-3.5 w-3.5" />
              {showDefaults ? 'Hide defaults' : 'Choose a default'}
            </Button>
            {user?.avatar_url && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAvatar(null)}
                disabled={busy}
                className="text-red-500 hover:text-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            PNG, JPEG, GIF, or WebP. Square images look best; they are shown as a circle.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {showDefaults && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          {!manifest ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500 py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading default avatars…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                <CategoryChip
                  label="All"
                  active={activeCategory === 'all'}
                  onClick={() => setActiveCategory('all')}
                />
                {manifest.categories.map((c) => (
                  <CategoryChip
                    key={c.key}
                    label={`${c.label} (${c.count})`}
                    active={activeCategory === c.key}
                    onClick={() => setActiveCategory(c.key)}
                  />
                ))}
              </div>
              <div className="grid grid-cols-6 sm:grid-cols-8 gap-2 max-h-72 overflow-auto pr-1">
                {shown.map((a) => {
                  // Stored avatar is the thumb; also match the full url so a
                  // previously-stored full-size pick still shows as selected.
                  const selected = user?.avatar_url === a.thumb || user?.avatar_url === a.url;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAvatar(a.thumb)}
                      disabled={busy}
                      title={a.id}
                      className={`relative rounded-full overflow-hidden aspect-square focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 transition-transform hover:scale-105 ${
                        selected ? 'ring-2 ring-primary-500' : 'ring-1 ring-zinc-200 dark:ring-zinc-700'
                      }`}
                    >
                      <img
                        src={a.thumb}
                        alt={a.id}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
        active
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
      }`}
    >
      {label}
    </button>
  );
}
