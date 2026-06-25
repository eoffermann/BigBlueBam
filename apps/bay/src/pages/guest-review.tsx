import { useEffect, useMemo, useState } from 'react';

// Public, unauthenticated guest review page (served at /bay/r/:token). It talks
// only to the token-scoped public API and never touches the auth store, so it
// works for anonymous browsers with no BigBlueBam session.

type MediaKind = 'image' | 'video' | 'audio' | 'model';

interface PublicAnnotation {
  id: string;
  author_name: string | null;
  is_guest: boolean;
  anchor: Record<string, unknown>;
  body: string;
  resolved: boolean;
  created_at: string;
}

interface PublicDecision {
  decision: 'approved' | 'rejected' | 'changes_requested' | 'pending';
  comment: string | null;
  reviewer_name: string | null;
  created_at: string;
}

interface PublicReview {
  name: string;
  media_kind: MediaKind;
  allow_comments: boolean;
  version: { id: string; version_number: number; bin_asset_id: string | null } | null;
  annotations: PublicAnnotation[];
  decisions: PublicDecision[];
}

const API = '/bay/api/v1/public/review';

function mediaUrl(token: string, variant?: 'proxy' | 'poster'): string {
  return `${API}/${token}/media${variant ? `?variant=${variant}` : ''}`;
}

const decisionStyle: Record<PublicDecision['decision'], string> = {
  approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  changes_requested: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  pending: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

export function GuestReviewPage({ token }: { token: string }) {
  const [review, setReview] = useState<PublicReview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound' | 'gone' | 'error'>('loading');
  const [useProxy, setUseProxy] = useState(true);

  // Comment form
  const [guestName, setGuestName] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      try {
        const res = await fetch(`${API}/${token}`, { headers: { Accept: 'application/json' } });
        if (res.status === 404) return setStatus('notfound');
        if (res.status === 410) return setStatus('gone');
        if (!res.ok) return setStatus('error');
        const json = (await res.json()) as { data: PublicReview };
        setReview(json.data);
        setUseProxy(true);
        setStatus('ok');
      } catch {
        setStatus('error');
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim() || !commentBody.trim()) return;
    setPosting(true);
    setPostErr(null);
    try {
      const res = await fetch(`${API}/${token}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: guestName.trim(), body: commentBody.trim() }),
      });
      if (!res.ok) {
        setPostErr(res.status === 403 ? 'Comments are disabled for this link.' : 'Could not post your comment.');
        return;
      }
      setCommentBody('');
      await load();
    } catch {
      setPostErr('Could not post your comment.');
    } finally {
      setPosting(false);
    }
  }

  if (status === 'loading') {
    return <Centered title="Loading review…" />;
  }
  if (status === 'notfound') {
    return <Centered title="Link not found" subtitle="This review link is invalid or has been revoked." />;
  }
  if (status === 'gone') {
    return <Centered title="Link expired" subtitle="This review link is no longer available." />;
  }
  if (status === 'error' || !review) {
    return <Centered title="Something went wrong" subtitle="Please try again in a moment." />;
  }

  const kind = review.media_kind;
  const hasMedia = Boolean(review.version?.bin_asset_id);
  const playableSrc =
    kind === 'video' || kind === 'audio' ? mediaUrl(token, useProxy ? 'proxy' : undefined) : mediaUrl(token);
  const onMediaError = () => {
    if (useProxy) setUseProxy(false);
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold">
            B
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">{review.name}</p>
            <p className="text-xs text-zinc-500">Shared review · read-only</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section>
          <div className="rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-black/5 dark:bg-black/30">
            {!hasMedia ? (
              <div className="aspect-video flex items-center justify-center text-sm text-zinc-500">
                No media attached to this review.
              </div>
            ) : kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl(token)} alt={review.name} className="block w-full max-h-[32rem] object-contain bg-zinc-900" />
            ) : kind === 'video' ? (
              // biome-ignore lint/a11y/useMediaCaption: shared review media has no caption track
              <video
                src={playableSrc}
                poster={mediaUrl(token, 'poster')}
                controls
                className="block w-full max-h-[32rem] bg-black"
                onError={onMediaError}
              />
            ) : kind === 'audio' ? (
              <div className="aspect-video flex items-center justify-center p-6">
                {/* biome-ignore lint/a11y/useMediaCaption: shared review media has no caption track */}
                <audio src={playableSrc} controls className="w-full max-w-md" onError={onMediaError} />
              </div>
            ) : (
              <div className="aspect-video flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
                <p>Preview not available for this media type.</p>
                <a href={mediaUrl(token)} className="text-primary-600 underline">Download to view</a>
              </div>
            )}
          </div>

          {review.decisions.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {review.decisions.map((d, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${decisionStyle[d.decision]}`}
                  title={d.comment ?? undefined}
                >
                  {d.decision.replace('_', ' ')}
                  {d.reviewer_name ? ` · ${d.reviewer_name}` : ''}
                </span>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            Comments ({review.annotations.length})
          </h2>
          <ul className="space-y-3">
            {review.annotations.map((a) => (
              <li
                key={a.id}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {a.author_name ?? 'Someone'}
                    {a.is_guest && <span className="ml-1 text-xs text-zinc-400">(guest)</span>}
                  </span>
                  {a.resolved && <span className="text-xs text-emerald-600">resolved</span>}
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{a.body}</p>
              </li>
            ))}
            {review.annotations.length === 0 && (
              <li className="text-sm text-zinc-500">No comments yet.</li>
            )}
          </ul>

          {review.allow_comments && (
            <form onSubmit={submitComment} className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Your name"
                maxLength={120}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              />
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Leave a comment…"
                maxLength={5000}
                rows={3}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              />
              {postErr && <p className="text-xs text-rose-600">{postErr}</p>}
              <button
                type="submit"
                disabled={posting || !guestName.trim() || !commentBody.trim()}
                className="w-full rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {posting ? 'Posting…' : 'Post comment'}
              </button>
            </form>
          )}
        </aside>
      </main>
    </div>
  );
}

function Centered({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="text-center space-y-2 px-6">
        <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-2xl bg-primary-600 text-white font-bold text-xl">
          B
        </div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-500">{subtitle}</p>}
      </div>
    </div>
  );
}
