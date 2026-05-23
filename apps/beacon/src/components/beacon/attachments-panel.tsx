import { useRef, useState } from 'react';
import { Paperclip, Upload, Loader2, Download, Trash2, File, Image as ImageIcon } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { Button } from '@/components/common/button';
import { useAuthStore } from '@/stores/auth.store';
import {
  useBeaconAttachments,
  useUploadBeaconAttachment,
  useDeleteBeaconAttachment,
  type BeaconAttachment,
} from '@/hooks/use-attachments';
import { formatRelativeTime } from '@/lib/utils';

interface AttachmentsPanelProps {
  beaconId: string;
}

const MAX_SIZE_BYTES = 10 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsPanel({ beaconId }: AttachmentsPanelProps) {
  const { data: attachments, isLoading, error } = useBeaconAttachments(beaconId);
  const uploadMutation = useUploadBeaconAttachment(beaconId);
  const deleteMutation = useDeleteBeaconAttachment(beaconId);
  const currentUser = useAuthStore((s) => s.user);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Wave E.D: replace inline role/is_superuser check with the per-action
  // permission for deleting any attachment (DELETE /beacons/:id/attachments/:aid →
  // beacon.beacon_attachment.delete). Authors can still delete their own
  // (canDelete below ORs in author identity); this controls cross-author delete.
  const isAdmin = useCan('beacon.beacon_attachment.delete');

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    const file = files[0]!;
    if (file.size === 0) {
      setUploadError('File is empty');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setUploadError(`File exceeds 10 MB limit`);
      return;
    }
    try {
      await uploadMutation.mutateAsync(file);
    } catch (e: any) {
      setUploadError(e?.message ?? 'Upload failed');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDelete = (a: BeaconAttachment) => {
    if (window.confirm(`Delete attachment '${a.filename}'?`)) {
      deleteMutation.mutate(a.id);
    }
  };

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-3">
        <Paperclip className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
          Attachments
          {attachments ? (
            <span className="ml-2 text-zinc-400 font-normal normal-case">({attachments.length})</span>
          ) : null}
        </h2>
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          dragActive
            ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/10'
            : 'border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="flex flex-col items-center gap-2 text-xs text-zinc-500">
          <Upload className="h-5 w-5 text-zinc-400" />
          <span>Drop a file here or</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            loading={uploadMutation.isPending}
          >
            Choose File
          </Button>
          <span className="text-[11px] text-zinc-400">
            Max 10 MB. Images, PDF, text, office docs.
          </span>
        </div>
      </div>

      {uploadError && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{uploadError}</p>
      )}

      {/* Attachment list */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-zinc-500 mt-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading attachments...
        </div>
      )}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 mt-3">
          Failed to load attachments: {(error as Error).message}
        </p>
      )}

      {attachments && attachments.length > 0 && (
        <ul className="mt-4 space-y-2">
          {attachments.map((a) => {
            const isImage = a.content_type.startsWith('image/');
            const canDelete = isAdmin || a.uploaded_by === currentUser?.id;
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3"
              >
                {/* Thumbnail / icon */}
                {isImage && a.download_url ? (
                  <a
                    href={a.download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 h-10 w-10 rounded-md overflow-hidden bg-zinc-100 dark:bg-zinc-800"
                  >
                    <img
                      src={a.download_url}
                      alt={a.filename}
                      className="h-full w-full object-cover"
                    />
                  </a>
                ) : (
                  <div className="shrink-0 h-10 w-10 rounded-md bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                    {isImage ? (
                      <ImageIcon className="h-4 w-4 text-zinc-400" />
                    ) : (
                      <File className="h-4 w-4 text-zinc-400" />
                    )}
                  </div>
                )}

                {/* Filename + meta */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                    {a.filename}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {formatBytes(a.size_bytes)}
                    {a.uploader_name ? ` . ${a.uploader_name}` : ''}
                    {' . '}
                    {formatRelativeTime(a.created_at)}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {a.download_url && (
                    <a
                      href={a.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-md text-zinc-500 hover:text-primary-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                      title="Download"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => handleDelete(a)}
                      disabled={deleteMutation.isPending}
                      className="p-1.5 rounded-md text-zinc-500 hover:text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
