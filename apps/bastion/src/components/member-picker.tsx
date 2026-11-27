import { useMembers } from '@/hooks/use-bastion';

/**
 * Pick a person in the organization by name (#268). Reusable across Bastion: anywhere a page needs
 * "who" (a questionnaire row's expert, a control owner), it shows names, never ids. The list comes
 * from the platform's member list (GET /b3/api/org/members), the same one other suite apps use.
 */
export function MemberPicker({
  value,
  onChange,
  label = 'Who should answer it',
  className = '',
}: {
  value: string | null;
  onChange: (userId: string | null) => void;
  label?: string;
  className?: string;
}) {
  const members = useMembers();
  const list = members.data ?? [];
  return (
    <label className={`block text-xs text-zinc-700 dark:text-zinc-300 ${className}`}>
      {label}
      <select
        className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        data-testid="member-picker"
        disabled={members.isLoading}
      >
        <option value="">{members.isLoading ? 'Loading people...' : members.error ? 'Could not load the people in your organization' : 'Choose a person'}</option>
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>
    </label>
  );
}
