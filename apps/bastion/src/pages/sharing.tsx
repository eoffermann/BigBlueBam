import { useMemo, useState } from 'react';
import { Copy, Download, Loader2, Lock, Plus } from 'lucide-react';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import { useCan } from '@bigbluebam/ui/use-can';
import { BASTION_ROOM_DEFAULT_DAYS } from '@bigbluebam/shared';
import { friendlyError } from '@/lib/errors';
import type { AuditorRoomRow, CreatedRoom, FrameworkView, RoomState } from '@/lib/api';
import { RoomView, formatDay } from '@/components/room-view';
import {
  useAuditorRequests,
  useAuditorRooms,
  useCreateExport,
  useCreateRoom,
  useExports,
  useManualEvidence,
  useRevokeRoom,
  useRoomAccessLog,
  useRoomPreview,
  useSetup,
  useUnlockRoom,
  useUpdateAuditorRequest,
} from '@/hooks/use-bastion';

// Sharing (spec 5.2, 6.1, 7.2): auditor rooms, the auditors' questions, and audit packets.
// Opening, closing and unlocking a room are disclosure acts a signed-in person does (spec 2.8):
// those buttons are disabled while impersonating, with the reason. Actions a viewer may not do are
// hidden (useCan, spec 6.3), never shown as an unexplained disabled button.

export const IMPERSONATING_NOTE = 'You are viewing Bastion as another person. Only that person can open, close or unlock an auditor room.';

const STATE_WORDS: Record<RoomState, string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked', locked: 'Locked' };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

const input = 'mt-1 block w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm';
const primary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50';
const secondary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50';
const card = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3';

function CreateRoomForm({ frameworks, onCreated, onCancel }: { frameworks: FrameworkView[]; onCreated: (r: CreatedRoom) => void; onCancel: () => void }) {
  const canRestricted = useCan('bastion.evidence.read_restricted');
  const evidence = useManualEvidence({ status: 'active' });
  const create = useCreateRoom();
  const [label, setLabel] = useState('');
  const [frameworkId, setFrameworkId] = useState(frameworks[0]?.id ?? '');
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(isoDay(new Date()));
  const [days, setDays] = useState(BASTION_ROOM_DEFAULT_DAYS);
  const [passcode, setPasscode] = useState('');
  const [restricted, setRestricted] = useState<string[]>([]);
  const restrictedItems = (evidence.data?.data ?? []).filter((e) => e.sensitivity === 'restricted' && !e.masked);
  return (
    <form
      className={card}
      data-testid="create-room-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          {
            label,
            framework_id: frameworkId,
            period_start: from,
            period_end: to,
            expires_in_days: days,
            restricted_evidence_ids: restricted,
            ...(passcode ? { passcode } : {}),
          },
          { onSuccess: (res) => onCreated(res.data) },
        );
      }}
    >
      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Create auditor room</h3>
      <label className="block text-sm">
        Who is this for?
        <input className={input} value={label} maxLength={256} placeholder="Lagoon & Reef CPAs, Type I readiness" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="block text-sm">
        Framework
        <select className={input} value={frameworkId} onChange={(e) => setFrameworkId(e.target.value)}>
          {frameworks.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          From
          <input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block text-sm">
          To
          <input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <label className="block text-sm">
        How long the link works (days)
        <input type="number" min={1} max={180} className={input} value={days} onChange={(e) => setDays(Number(e.target.value))} />
      </label>
      <label className="block text-sm">
        Passcode (optional, 6 digits)
        <input className={input} inputMode="numeric" maxLength={6} value={passcode} autoComplete="off" onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ''))} />
      </label>
      {canRestricted && restrictedItems.length > 0 && (
        <fieldset className="text-sm space-y-1">
          <legend className="font-medium">Restricted evidence to include</legend>
          <p className="text-xs text-zinc-500">Restricted items stay hidden from the auditor unless you tick them here.</p>
          {restrictedItems.map((e) => (
            <label key={e.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={restricted.includes(e.id)}
                onChange={(ev) => setRestricted((cur) => (ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id)))}
              />
              {e.title}
            </label>
          ))}
        </fieldset>
      )}
      {create.error && <p className="text-sm text-red-600">{friendlyError(create.error)}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={!label.trim() || !frameworkId || (passcode.length > 0 && passcode.length !== 6) || create.isPending}>
          Create room
        </button>
        <button type="button" className={secondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function OneTimeLink({ room, onDone }: { room: CreatedRoom; onDone: () => void }) {
  const link = `${window.location.origin}${room.link}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border-2 border-primary-400 bg-primary-50 dark:bg-primary-950/30 p-4 space-y-2" data-testid="room-link-once">
      <p className="font-medium text-zinc-900 dark:text-zinc-100">Copy this link now. It is shown only once.</p>
      <div className="flex gap-2 items-center">
        <input readOnly className={`${input} font-mono`} value={link} data-testid="room-link" onFocus={(e) => e.target.select()} />
        <button
          type="button"
          className={secondary}
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
          }}
        >
          <Copy className="h-4 w-4" /> Copy link
        </button>
      </div>
      {copied && <p className="text-xs text-green-700">Copied.</p>}
      <p className="text-xs text-zinc-600">Send it to the auditor in a private message. Anyone with the link can open the room until it expires or you revoke it.</p>
      <button type="button" className={secondary} onClick={onDone}>
        I have copied it
      </button>
    </div>
  );
}

function AccessLog({ roomId }: { roomId: string }) {
  const log = useRoomAccessLog(roomId);
  if (log.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
  const rows = log.data?.data ?? [];
  return (
    <table className="min-w-full text-sm" data-testid="access-log">
      <thead className="text-left text-xs text-zinc-500">
        <tr>
          <th className="py-1 pr-3">When</th>
          <th className="py-1 pr-3">What</th>
          <th className="py-1 pr-3">Visitor</th>
          <th className="py-1">Device</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="py-1 pr-3">{new Date(r.accessed_at).toLocaleString()}</td>
            <td className="py-1 pr-3">{r.what}</td>
            <td className="py-1 pr-3">{r.visitor}</td>
            <td className="py-1">{r.device}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={4} className="py-1 text-zinc-500">
              Nobody has opened this room yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Preview({ roomId }: { roomId: string }) {
  const preview = useRoomPreview(roomId);
  if (preview.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
  if (preview.error) return <p className="text-sm text-red-600">{friendlyError(preview.error)}</p>;
  return preview.data ? (
    <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-4" data-testid="room-preview">
      <p className="text-xs text-zinc-500 mb-3">This is exactly what the auditor sees.</p>
      <RoomView data={preview.data.data} />
    </div>
  ) : null;
}

function RoomRow({ room }: { room: AuditorRoomRow }) {
  const canCreate = useCan('bastion.auditor_room.create');
  const canRevoke = useCan('bastion.auditor_room.revoke');
  const impersonating = getImpersonation() !== null;
  const revoke = useRevokeRoom();
  const unlock = useUnlockRoom();
  const [open, setOpen] = useState<'preview' | 'log' | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const live = room.state === 'active' || room.state === 'locked';
  return (
    <li className="py-3 space-y-2" data-testid="room-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{room.label}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {room.framework_name ?? 'Framework removed'}. {STATE_WORDS[room.state]}
            {room.state === 'active' ? `, works until ${formatDay(room.expires_at)}` : ''}. {room.access_count} {room.access_count === 1 ? 'view' : 'views'}
            {room.last_accessed_at ? `, last opened ${new Date(room.last_accessed_at).toLocaleString()}` : ', never opened'}.
            {room.open_requests > 0 ? ` ${room.open_requests} open ${room.open_requests === 1 ? 'question' : 'questions'}.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondary} onClick={() => setOpen(open === 'preview' ? null : 'preview')}>
            Preview
          </button>
          <button type="button" className={secondary} onClick={() => setOpen(open === 'log' ? null : 'log')}>
            Access log
          </button>
          {room.state === 'locked' && canCreate && (
            <button type="button" className={secondary} disabled={impersonating || unlock.isPending} title={impersonating ? IMPERSONATING_NOTE : undefined} onClick={() => unlock.mutate(room.id)}>
              <Lock className="h-4 w-4" /> Unlock
            </button>
          )}
          {live && canRevoke && (
            <button type="button" className={secondary} disabled={impersonating} title={impersonating ? IMPERSONATING_NOTE : undefined} onClick={() => setConfirmRevoke(true)}>
              Revoke
            </button>
          )}
        </div>
      </div>
      {room.state === 'locked' && <p className="text-xs text-amber-700">This room locked itself after 5 wrong passcodes. Unlock it to let the auditor try again.</p>}
      {confirmRevoke && (
        <section aria-label="Revoke this room" className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 space-y-2">
          <p className="text-sm">Revoke this room? The link stops working at once and cannot be turned back on.</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white disabled:opacity-50"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(room.id, { onSuccess: () => setConfirmRevoke(false) })}
            >
              Revoke room
            </button>
            <button type="button" className={secondary} onClick={() => setConfirmRevoke(false)}>
              Keep it
            </button>
          </div>
        </section>
      )}
      {(revoke.error || unlock.error) && <p className="text-sm text-red-600">{friendlyError(revoke.error ?? unlock.error)}</p>}
      {open === 'preview' && <Preview roomId={room.id} />}
      {open === 'log' && <AccessLog roomId={room.id} />}
    </li>
  );
}

function Questions() {
  const canRespond = useCan('bastion.auditor_room.respond');
  const requests = useAuditorRequests();
  const update = useUpdateAuditorRequest();
  const [answering, setAnswering] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const rows = requests.data?.data ?? [];
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Auditor questions</h2>
      {rows.length === 0 && <p className="text-sm text-zinc-500">No questions yet. Auditors can ask from inside their room.</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((q) => (
          <li key={q.id} className="py-2 space-y-1 text-sm">
            <p className="text-zinc-900 dark:text-zinc-100">{q.body}</p>
            <p className="text-xs text-zinc-500">
              {q.requester_name ?? 'An auditor'} in {q.room_label}
              {q.control_title ? `, about ${q.control_title}` : ''}, {new Date(q.created_at).toLocaleString()}.{' '}
              {q.status === 'open' ? 'Open' : q.status === 'answered' ? `Answered${q.answered_by_name ? ` by ${q.answered_by_name}` : ''}` : 'Closed'}
            </p>
            {q.answer_note && <p className="text-zinc-700 dark:text-zinc-300">Answer: {q.answer_note}</p>}
            {canRespond && q.status !== 'closed' && (
              <div className="flex gap-2">
                <button type="button" className={secondary} onClick={() => setAnswering(answering === q.id ? null : q.id)}>
                  Answer
                </button>
                <button type="button" className={secondary} onClick={() => update.mutate({ id: q.id, body: { status: 'closed' } })}>
                  Close
                </button>
              </div>
            )}
            {answering === q.id && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  update.mutate({ id: q.id, body: { status: 'answered', answer_note: note } }, { onSuccess: () => { setAnswering(null); setNote(''); } });
                }}
              >
                <textarea className={input} rows={3} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Your answer" />
                <button type="submit" className={primary} disabled={!note.trim() || update.isPending}>
                  Send answer
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {update.error && <p className="text-sm text-red-600">{friendlyError(update.error)}</p>}
    </section>
  );
}

function Packets({ frameworks }: { frameworks: FrameworkView[] }) {
  const canCreate = useCan('bastion.export.create');
  const canRestricted = useCan('bastion.evidence.read_restricted');
  const exports = useExports();
  const create = useCreateExport();
  const [open, setOpen] = useState(false);
  const [frameworkId, setFrameworkId] = useState(frameworks[0]?.id ?? '');
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(isoDay(new Date()));
  const [withRestricted, setWithRestricted] = useState(false);
  const rows = exports.data?.data ?? [];
  return (
    <section className={card}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Audit packets</h2>
        {canCreate && !open && (
          <button type="button" className={primary} onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Build a packet
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        A packet is a zip an auditor can keep: every control, the evidence files, signed daily seals, accepted risks, changes, and a summary.
      </p>
      {open && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ framework_id: frameworkId, period_start: from, period_end: to, include_restricted: withRestricted }, { onSuccess: () => setOpen(false) });
          }}
        >
          <label className="block text-sm">
            Framework
            <select className={input} value={frameworkId} onChange={(e) => setFrameworkId(e.target.value)}>
              {frameworks.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              From
              <input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="block text-sm">
              To
              <input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {canRestricted && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withRestricted} onChange={(e) => setWithRestricted(e.target.checked)} />
              Include restricted evidence
            </label>
          )}
          {create.error && <p className="text-sm text-red-600">{friendlyError(create.error)}</p>}
          <div className="flex gap-2">
            <button type="submit" className={primary} disabled={!frameworkId || create.isPending}>
              Build packet
            </button>
            <button type="button" className={secondary} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="packet-list">
        {rows.map((p) => (
          <li key={p.id} className="py-2 flex items-center justify-between gap-3 text-sm">
            <div>
              <p className="text-zinc-900 dark:text-zinc-100">
                {p.framework_name ?? 'Framework removed'}, {formatDay(p.period_start)} to {formatDay(p.period_end)}
                {p.include_restricted ? ', with restricted evidence' : ''}
              </p>
              <p className="text-xs text-zinc-500">
                {p.stage_words}
                {p.requested_by_name ? `. Asked for by ${p.requested_by_name}` : ''}, {new Date(p.created_at).toLocaleString()}
              </p>
              {p.status === 'failed' && p.error && <p className="text-xs text-red-600">{p.error}</p>}
            </div>
            {p.status === 'succeeded' && (
              <a className={secondary} href={`/bastion/api/v1/exports/${p.id}/download`}>
                <Download className="h-4 w-4" /> Download
              </a>
            )}
            {(p.status === 'queued' || p.status === 'running') && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
          </li>
        ))}
        {rows.length === 0 && <li className="py-2 text-sm text-zinc-500">No packets yet.</li>}
      </ul>
      {frameworks.some((f) => f.is_iso) && (
        <div className="text-sm space-y-1">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">Statement of Applicability</p>
          {frameworks
            .filter((f) => f.is_iso)
            .map((f) => (
              <a key={f.id} className="inline-flex items-center gap-1 text-primary-700 dark:text-primary-300 hover:underline" href={`/bastion/api/v1/frameworks/${f.id}/statement-of-applicability`}>
                <Download className="h-4 w-4" /> Download the Statement of Applicability for {f.name}
              </a>
            ))}
        </div>
      )}
    </section>
  );
}

export function SharingPage() {
  const setup = useSetup();
  const canRead = useCan('bastion.auditor_room.read');
  const canCreate = useCan('bastion.auditor_room.create');
  const canExports = useCan('bastion.export.read');
  const impersonating = getImpersonation() !== null;
  const rooms = useAuditorRooms(canRead);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedRoom | null>(null);
  const frameworks = useMemo(() => (setup.data?.data.frameworks ?? []).filter((f) => f.status !== 'archived'), [setup.data]);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Sharing</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Share your evidence with an auditor through a private room, answer their questions, and build audit packets.</p>
      </div>

      {canRead && (
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Auditor rooms</h2>
            {canCreate && !creating && (
              <button type="button" className={primary} disabled={impersonating || frameworks.length === 0} title={impersonating ? IMPERSONATING_NOTE : undefined} onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Create auditor room
              </button>
            )}
          </div>
          {impersonating && canCreate && <p className="text-xs text-amber-700">{IMPERSONATING_NOTE}</p>}
          {frameworks.length === 0 && setup.isSuccess && <p className="text-sm text-zinc-500">Adopt a framework in Setup before sharing it.</p>}
          {created && <OneTimeLink room={created} onDone={() => setCreated(null)} />}
          {creating && (
            <CreateRoomForm
              frameworks={frameworks}
              onCancel={() => setCreating(false)}
              onCreated={(r) => {
                setCreating(false);
                setCreated(r);
              }}
            />
          )}
          {rooms.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {(rooms.data?.data ?? []).map((r) => (
                <RoomRow key={r.id} room={r} />
              ))}
              {(rooms.data?.data ?? []).length === 0 && <li className="py-2 text-sm text-zinc-500">No rooms yet. Create one to give an auditor a private, read-only view.</li>}
            </ul>
          )}
        </section>
      )}

      {canRead && <Questions />}
      {canExports && <Packets frameworks={frameworks} />}
      {!canRead && !canExports && <p className="text-sm text-zinc-500">Sharing is available to your organization's owners and admins.</p>}
    </div>
  );
}
