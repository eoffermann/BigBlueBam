/**
 * Image underlay upload control for the floor editor.
 *
 * Strategy: piggy-back on Bam's POST /b3/api/upload endpoint (the same one
 * used by Brief and Board for attachments). The response shape is
 *   { data: { url: string, key: string, filename: string, ... } }
 * — `url` is a /files/... path proxied through nginx (no MinIO secrets
 * exposed). We then PATCH it onto the floor row.
 *
 * If the upload fails, we surface the error inline. There's no progress
 * bar yet — most underlays are well under the 25MB Bam limit and the
 * upload finishes faster than a spinner sweep.
 *
 * Files allowed: image/* (Bam's upload route blocks SVG already, so no
 * extra guards here).
 *
 * The control supports two states: "no underlay" (Upload button) and
 * "underlay set" (preview + Replace + Remove). The Remove path passes
 * `null` to the parent, which then clears `background_url` server-side.
 *
 * Per CLAUDE.md "feature-that-doesnt-work-is-a-bug" — we wire to the
 * real Bam endpoint rather than stub. The only TODO is the
 * MinIO-on-bureau-api story: today the file goes into Bam's S3_BUCKET,
 * which is fine because nginx serves /files/* from there for all SPAs.
 */

import { useRef, useState } from 'react';
import { ImageIcon, Loader2, Upload, X } from 'lucide-react';

export interface ImageUnderlayUploadProps {
  /** Current underlay URL, if any (e.g. '/files/uploads/abc-bg.png'). */
  value: string | null;
  /** Called with the new URL (or null for remove). */
  onChange: (url: string | null) => void;
}

interface UploadResponse {
  data?: { url?: string };
}

export function ImageUnderlayUpload({ value, onChange }: ImageUnderlayUploadProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/b3/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j.error?.message) msg = j.error.message;
        } catch {
          /* keep default */
        }
        throw new Error(msg);
      }
      const json = (await res.json()) as UploadResponse;
      const url = json.data?.url;
      if (!url) throw new Error('Server did not return a URL');
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />
      {value ? (
        <>
          <div
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-200"
            title={value}
          >
            <ImageIcon className="h-3.5 w-3.5 text-zinc-500" />
            <span className="max-w-[140px] truncate font-mono text-[11px]">
              {value.split('/').pop()}
            </span>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Replace
          </button>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={uploading}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
            title="Remove underlay"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
          Image underlay…
        </button>
      )}
      {error && (
        <span className="text-[11px] text-red-600 dark:text-red-400 max-w-[200px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
