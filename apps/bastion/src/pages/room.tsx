import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Castle, Loader2 } from 'lucide-react';
import { BASTION_ROOM_PASSCODE_HEADER, BASTION_ROOM_TOKEN_HEADER } from '@bigbluebam/shared';
import { ApiError, roomRequest, type RoomControlDetail, type RoomEvidenceDetail, type RoomOverview } from '@/lib/api';
import { RiskList, RoomView, StateChip, formatDay } from '@/components/room-view';

// The public auditor room (spec 5.2, 6.1), rendered BEFORE the auth gate: no BigBlueBam session.
// The token is read from the URL fragment (/bastion/room#<token>), which browsers never send to a
// server, and goes to bastion-api only as the X-Bastion-Room-Token header; it never appears in a
// path or query string. The passcode lives in this component's state only.

export const ROOM_GONE = 'This link is no longer available.';

export function readRoomToken(hash: string): string {
  return hash.replace(/^#/, '').trim();
}

type View = { kind: 'overview' } | { kind: 'control'; id: string } | { kind: 'evidence'; id: string; controlId: string };

function attemptsLeft(err: ApiError): number | null {
  const issue = (err.details ?? []).map((d) => String((d as { issue?: unknown }).issue ?? '')).find((i) => i.startsWith('attempts_left:'));
  return issue ? Number(issue.slice('attempts_left:'.length)) : null;
}

export function AuditorRoomPage() {
  const [token] = useState(() => readRoomToken(window.location.hash));
  const [passcode, setPasscode] = useState<string | null>(null);
  const [passcodeDraft, setPasscodeDraft] = useState('');
  const [needPasscode, setNeedPasscode] = useState<{ wrong: boolean; left: number | null } | null>(null);
  const [gone, setGone] = useState(false);
  const [overview, setOverview] = useState<RoomOverview | null>(null);
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [control, setControl] = useState<RoomControlDetail | null>(null);
  const [evidence, setEvidence] = useState<RoomEvidenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const call = useCallback(
    <T,>(path: string, opts: { method?: string; body?: unknown } = {}) =>
      roomRequest<T>(path, token, { ...opts, passcode, tokenHeader: BASTION_ROOM_TOKEN_HEADER, passcodeHeader: BASTION_ROOM_PASSCODE_HEADER }),
    [token, passcode],
  );

  const handle = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) {
      setGone(true);
      return;
    }
    if (err instanceof ApiError && err.status === 401 && (err.code === 'PASSCODE_REQUIRED' || err.code === 'PASSCODE_WRONG')) {
      setNeedPasscode({ wrong: err.code === 'PASSCODE_WRONG', left: attemptsLeft(err) });
      return;
    }
    setError(err instanceof ApiError && err.status < 500 ? err.message : 'Something went wrong. Please try again in a moment.');
  }, []);

  useEffect(() => {
    if (!token) {
      setGone(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const run = async () => {
      try {
        if (view.kind === 'overview') {
          setOverview((await call<{ data: RoomOverview }>('')).data);
        } else if (view.kind === 'control') {
          setControl((await call<{ data: RoomControlDetail }>(`/controls/${view.id}`)).data);
        } else {
          setEvidence((await call<{ data: RoomEvidenceDetail }>(`/evidence/${view.id}`)).data);
        }
        setNeedPasscode(null);
      } catch (err) {
        handle(err);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [token, view, call, handle]);

  const download = async (id: string, title: string) => {
    try {
      const blob = await call<Blob>(`/evidence/${id}?download=1`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = title;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      handle(err);
    }
  };

  const shell = (body: ReactNode) => (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-2">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white">
            <Castle className="h-4 w-4" />
          </div>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">Auditor room</span>
        </div>
      </div>
      <main className="max-w-5xl mx-auto px-4 py-6">{body}</main>
    </div>
  );

  if (gone) {
    return shell(
      <p className="text-lg text-zinc-700 dark:text-zinc-300" data-testid="room-gone">
        {ROOM_GONE}
      </p>,
    );
  }
  if (needPasscode) {
    return shell(
      <form
        className="max-w-sm space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setPasscode(passcodeDraft);
          setView({ ...view });
        }}
      >
        <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Enter the 6-digit passcode
          <input
            className="mt-1 block w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 tracking-widest"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={passcodeDraft}
            onChange={(e) => setPasscodeDraft(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        {needPasscode.wrong && (
          <p className="text-sm text-red-600">
            That passcode is not right.{needPasscode.left !== null ? ` ${needPasscode.left} ${needPasscode.left === 1 ? 'try' : 'tries'} left before the room locks.` : ''}
          </p>
        )}
        <button type="submit" disabled={passcodeDraft.length !== 6} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white disabled:opacity-50">
          Open the room
        </button>
      </form>,
    );
  }
  if (loading && !overview && !control && !evidence) return shell(<Loader2 className="h-6 w-6 animate-spin text-zinc-400" />);

  const back = (to: View, label: string) => (
    <button type="button" className="text-sm text-primary-700 dark:text-primary-300 hover:underline" onClick={() => setView(to)}>
      {label}
    </button>
  );

  return shell(
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {view.kind === 'overview' && overview && (
        <>
          <RoomView data={overview} onOpenControl={(id) => setView({ kind: 'control', id })} />
          <AskQuestion controls={overview.controls.map((c) => ({ id: c.id, title: c.title }))} send={(body) => call('/requests', { method: 'POST', body })} />
        </>
      )}
      {view.kind === 'control' && control && (
        <div className="space-y-4" data-testid="room-control">
          {back({ kind: 'overview' }, 'Back to all controls')}
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{control.control.title}</h1>
            <StateChip control={control.control} />
          </div>
          {control.control.reason && <p className="text-sm text-zinc-700 dark:text-zinc-300">{control.control.reason}</p>}
          <section>
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Requirements</h2>
            <ul className="text-sm text-zinc-700 dark:text-zinc-300">
              {control.requirements.map((r) => (
                <li key={r.ref_code}>
                  {r.ref_code} {r.title ?? ''}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Checks in the period</h2>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {control.evidence.map((e) => (
                <li key={e.id} className="py-2 text-sm">
                  <button type="button" className="text-primary-700 dark:text-primary-300 hover:underline" onClick={() => setView({ kind: 'evidence', id: e.id, controlId: control.control.id })}>
                    {formatDay(e.recorded_at)}: {e.outcome_words}
                  </button>
                  {e.what && <p className="text-zinc-600 dark:text-zinc-400">{e.what}</p>}
                  {e.explanation && <p className="text-zinc-500">{e.explanation}</p>}
                </li>
              ))}
              {control.evidence.length === 0 && <li className="py-2 text-sm text-zinc-500">No checks were recorded in this period.</li>}
            </ul>
          </section>
          <section>
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Uploaded evidence</h2>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {control.files.map((f) => (
                <li key={f.id} className="py-2 text-sm">
                  <button type="button" className="text-primary-700 dark:text-primary-300 hover:underline" onClick={() => setView({ kind: 'evidence', id: f.id, controlId: control.control.id })}>
                    {f.title}
                  </button>
                  <p className="text-zinc-500">
                    {f.kind === 'statement' ? 'Written statement' : 'Uploaded file'}
                    {f.produced_on ? `, produced ${formatDay(f.produced_on)}` : ''}. {f.review}.{f.restricted ? ' Restricted.' : ''}
                  </p>
                  {f.scan && <p className="text-xs text-amber-700">{f.scan}</p>}
                </li>
              ))}
              {control.files.length === 0 && <li className="py-2 text-sm text-zinc-500">Nothing was uploaded for this control in this period.</li>}
            </ul>
          </section>
          {control.accepted_risks.length > 0 && (
            <section>
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Accepted risks</h2>
              <RiskList risks={control.accepted_risks} />
            </section>
          )}
        </div>
      )}
      {view.kind === 'evidence' && evidence && (
        <div className="space-y-3" data-testid="room-evidence">
          {back({ kind: 'control', id: view.controlId }, 'Back to the control')}
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{evidence.kind === 'check' ? (evidence.control_title ?? 'Check') : evidence.title}</h1>
          {evidence.recorded_at && <p className="text-sm text-zinc-600">Recorded {formatDay(evidence.recorded_at)}</p>}
          {evidence.what && <p className="text-sm text-zinc-700 dark:text-zinc-300">{evidence.what}</p>}
          {evidence.outcome_words && <p className="text-sm font-medium">{evidence.outcome_words}</p>}
          {evidence.explanation && <p className="text-sm text-zinc-600">{evidence.explanation}</p>}
          {evidence.review && <p className="text-sm text-zinc-600">{evidence.review}</p>}
          {evidence.file_words && <p className="text-sm font-medium text-red-700">{evidence.file_words}</p>}
          {evidence.kind !== 'check' && evidence.file === 'available' && (
            <button type="button" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white" onClick={() => void download(evidence.id, evidence.title ?? 'evidence')}>
              Download
            </button>
          )}
        </div>
      )}
    </div>,
  );
}

function AskQuestion({ controls, send }: { controls: Array<{ id: string; title: string }>; send: (body: unknown) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [controlId, setControlId] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" className="px-4 py-2 rounded-lg text-sm font-medium border border-zinc-300 dark:border-zinc-700" onClick={() => setOpen(true)}>
        Ask a question
      </button>
    );
  }
  return (
    <form
      className="space-y-3 max-w-xl rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setState('sending');
        try {
          await send({ requester_name: name, body, ...(controlId ? { control_id: controlId } : {}) });
          setState('sent');
          setMessage('Your question was sent. The team will answer it in Bastion.');
          setBody('');
        } catch (err) {
          setState('error');
          setMessage(err instanceof ApiError ? err.message : 'Your question could not be sent. Try again.');
        }
      }}
    >
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Ask a question</h2>
      <label className="block text-sm">
        Your name
        <input className="mt-1 block w-full rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1" value={name} maxLength={256} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-sm">
        About which control (optional)
        <select className="mt-1 block w-full rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1" value={controlId} onChange={(e) => setControlId(e.target.value)}>
          <option value="">Not about one control</option>
          {controls.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Your question
        <textarea className="mt-1 block w-full rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1" rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <button type="submit" disabled={!name.trim() || !body.trim() || state === 'sending'} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white disabled:opacity-50">
        Send question
      </button>
      {message && <p className={`text-sm ${state === 'error' ? 'text-red-600' : 'text-green-700'}`}>{message}</p>}
    </form>
  );
}
