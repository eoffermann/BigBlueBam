import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import { useBookingPage, useCreateBookingPage, useUpdateBookingPage } from '@/hooks/use-booking-pages';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface BookingPageEditorProps {
  bookingPageId?: string;
  onNavigate: (path: string) => void;
}

export function BookingPageEditorPage({ bookingPageId, onNavigate }: BookingPageEditorProps) {
  const isNew = !bookingPageId || bookingPageId === 'new';
  const { data: existingData, isLoading } = useBookingPage(isNew ? undefined : bookingPageId);
  const createPage = useCreateBookingPage();
  const updatePage = useUpdateBookingPage(bookingPageId ?? '');

  const existing = existingData?.data;

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState(30);
  const [bufferBefore, setBufferBefore] = useState(0);
  const [bufferAfter, setBufferAfter] = useState(15);
  const [color, setColor] = useState('#3b82f6');

  // Populate form when editing an existing booking page
  const [populated, setPopulated] = useState(false);
  useEffect(() => {
    if (!isNew && existing && !populated) {
      setTitle(existing.title);
      setSlug(existing.slug);
      setDescription(existing.description ?? '');
      setDuration(existing.duration_minutes);
      setBufferBefore(existing.buffer_before_min);
      setBufferAfter(existing.buffer_after_min);
      setColor(existing.color ?? '#3b82f6');
      setPopulated(true);
    }
  }, [isNew, existing, populated]);

  const handleSave = async () => {
    if (!title.trim() || !slug.trim()) return;
    const payload = {
      title,
      slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      description: description || undefined,
      duration_minutes: duration,
      buffer_before_min: bufferBefore,
      buffer_after_min: bufferAfter,
      color,
    };

    if (isNew) {
      await createPage.mutateAsync(payload);
    } else {
      await updatePage.mutateAsync(payload as any);
    }
    onNavigate('/booking-pages');
  };

  const isPending = createPage.isPending || updatePage.isPending;

  if (!isNew && isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <button
        onClick={() => onNavigate('/booking-pages')}
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Booking Pages
      </button>

      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {isNew ? 'New Booking Page' : 'Edit Booking Page'}
        </h1>
        {!isNew && existing && (
          <div className="ml-auto">
            <PresenceChipStrip
              url={`${window.location.origin}${window.location.pathname}`}
              surfaceApp="book"
              surfaceId={existing.id}
              surfaceLabel={existing.title}
            />
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="30-Minute Intro Call"
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            URL Slug
          </label>
          <div className="flex items-center">
            <span className="px-3 py-2 text-sm text-zinc-500 bg-zinc-100 dark:bg-zinc-700 border border-r-0 border-zinc-200 dark:border-zinc-600 rounded-l-lg">
              /meet/
            </span>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="intro-call"
              className="flex-1 px-3 py-2 rounded-r-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description shown to visitors..."
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Duration (min)
            </label>
            <input
              type="number"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              min={5}
              max={480}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Buffer Before (min)
            </label>
            <input
              type="number"
              value={bufferBefore}
              onChange={(e) => setBufferBefore(Number(e.target.value))}
              min={0}
              max={60}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Buffer After (min)
            </label>
            <input
              type="number"
              value={bufferAfter}
              onChange={(e) => setBufferAfter(Number(e.target.value))}
              min={0}
              max={60}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Brand Color
          </label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-10 w-20 rounded border border-zinc-200 dark:border-zinc-700 cursor-pointer"
          />
        </div>
      </div>

      <div className="flex gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-700">
        <button
          onClick={handleSave}
          disabled={isPending || !title.trim() || !slug.trim()}
          className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {isPending ? 'Saving...' : isNew ? 'Create' : 'Update'}
        </button>
        <button
          onClick={() => onNavigate('/booking-pages')}
          className="px-4 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
