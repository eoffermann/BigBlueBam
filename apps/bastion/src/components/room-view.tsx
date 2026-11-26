import type { RoomControl, RoomOverview } from '@/lib/api';

// What an auditor sees in a room (spec 5.2). ONE component renders the public room and the
// creator's Preview on the Sharing page, so both always show the same thing. Plain words only:
// no ids or hashes on the default view; the seal history sits in a Technical details disclosure.

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: iso.length === 10 ? 'UTC' : undefined });
}

const STATE_STYLE: Record<RoomControl['state'], string> = {
  met: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  not_met: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  risk_accepted: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  cant_prove: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
  not_assessed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

export function StateChip({ control }: { control: Pick<RoomControl, 'state' | 'state_words'> }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[control.state]}`}>{control.state_words}</span>;
}

const NUMBER_LABELS: Array<[keyof RoomOverview['numbers'], string]> = [
  ['met', 'Met'],
  ['not_met', 'Not met'],
  ['risk_accepted', 'Not met, risk accepted'],
  ['cant_prove', "Can't prove yet"],
  ['not_assessed', 'Not assessed'],
];

export function RoomView({ data, onOpenControl }: { data: RoomOverview; onOpenControl?: (id: string) => void }) {
  return (
    <div className="space-y-6" data-testid="room-view">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{data.room.label}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Shared by {data.room.organization_name} until {formatDay(data.room.expires_at)}
          {data.room.framework_name ? `. ${data.room.framework_name}` : ''}
          {data.room.period_start && data.room.period_end ? `, ${formatDay(data.room.period_start)} to ${formatDay(data.room.period_end)}` : ''}
        </p>
        <p className="text-xs text-zinc-500">{data.not_an_audit}</p>
      </header>

      {data.notices.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-1" data-testid="room-notices">
          {data.notices.map((n) => (
            <p key={n} className="text-sm text-amber-900 dark:text-amber-200">
              {n}
            </p>
          ))}
        </div>
      )}

      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {NUMBER_LABELS.map(([k, label]) => (
          <div key={k} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
            <div className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{data.numbers[k]}</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{label}</div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Controls</h2>
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          {data.controls.map((c) => (
            <li key={c.id} className="p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                {onOpenControl ? (
                  <button type="button" className="text-left font-medium text-primary-700 dark:text-primary-300 hover:underline" onClick={() => onOpenControl(c.id)}>
                    {c.title}
                  </button>
                ) : (
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{c.title}</span>
                )}
                {c.reason && <p className="text-xs text-zinc-600 dark:text-zinc-400">{c.reason}</p>}
                {c.requirement_codes.length > 0 && <p className="text-xs text-zinc-500">{c.requirement_codes.join(', ')}</p>}
              </div>
              <StateChip control={c} />
            </li>
          ))}
          {data.controls.length === 0 && <li className="p-3 text-sm text-zinc-500">No controls are shared in this room.</li>}
        </ul>
      </section>

      {data.restricted_items.length > 0 && (
        <section className="space-y-2" data-testid="room-restricted">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Restricted evidence included</h2>
          <ul className="list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {data.restricted_items.map((r) => (
              <li key={r.id}>{r.title}</li>
            ))}
          </ul>
        </section>
      )}

      {data.accepted_risks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Accepted risks</h2>
          <RiskList risks={data.accepted_risks} />
        </section>
      )}

      {data.statement_of_applicability && (
        <section className="space-y-2" data-testid="room-soa">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Statement of Applicability</h2>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-800 text-left text-xs text-zinc-600 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Requirement</th>
                  <th className="px-3 py-2">Applies</th>
                  <th className="px-3 py-2">Why</th>
                  <th className="px-3 py-2">How it is met</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800 bg-white dark:bg-zinc-900">
                {data.statement_of_applicability.map((r) => (
                  <tr key={r.ref_code}>
                    <td className="px-3 py-1.5">
                      {r.ref_code} {r.title}
                    </td>
                    <td className="px-3 py-1.5">{r.applicable}</td>
                    <td className="px-3 py-1.5">{r.justification}</td>
                    <td className="px-3 py-1.5">{[r.implementing_controls, r.current_status].filter(Boolean).join(': ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <details className="text-xs text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer">Technical details: signed daily seals</summary>
        <p className="mt-2">Keep your own copy of these seals. Each one is signed with one of the public keys below.</p>
        <ul className="mt-2 space-y-1 font-mono break-all">
          {data.public_keys.map((k) => (
            <li key={k.signing_key_id}>
              Key {k.signing_key_id}
              {k.current ? ' (current)' : ''}: {k.public_key_hex}
            </li>
          ))}
        </ul>
        <ul className="mt-2 space-y-1 font-mono break-all">
          {data.seals.map((s) => (
            <li key={s.seal_date}>
              {s.seal_date} epoch {s.epoch} entry {s.head_seq}: {s.head_hash} signed by {s.signing_key_id}: {s.signature}
            </li>
          ))}
          {data.seals.length === 0 && <li>No seals yet: seals are written once a day.</li>}
        </ul>
      </details>
    </div>
  );
}

export function RiskList({ risks }: { risks: RoomOverview['accepted_risks'] }) {
  return (
    <ul className="space-y-2">
      {risks.map((r) => (
        <li key={r.id} className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{r.control_title}</p>
          <p className="text-zinc-700 dark:text-zinc-300">{r.reason}</p>
          {r.compensating_note && <p className="text-zinc-600 dark:text-zinc-400">In the meantime: {r.compensating_note}</p>}
          <p className="text-xs text-zinc-500">
            {r.owner ? `Owner ${r.owner}. ` : ''}Accepted until {formatDay(r.expires_at)}.
          </p>
        </li>
      ))}
    </ul>
  );
}
