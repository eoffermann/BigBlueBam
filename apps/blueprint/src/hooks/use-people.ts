import { useQuery } from '@tanstack/react-query';
import { bbbGet } from '@/lib/bbb-api';

/**
 * People lookup off the shared Bam API (`GET /b3/api/people`). Blueprint's
 * comment/collaborator rows only carry user UUIDs, so we resolve names and
 * avatars here. Used both to build a UUID -> person map (so comments and
 * collaborators can show a display name) and to power the "add collaborator"
 * search picker.
 */
export interface Person {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

// The People Manager endpoint nests the user under a `user` key alongside
// membership/cap metadata we don't need here: { data: [{ user: {...}, ... }] }.
interface PeopleRow {
  user: {
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
  };
}

export function usePeople(search?: string) {
  const trimmed = (search ?? '').trim();
  return useQuery({
    queryKey: ['blueprint', 'bam', 'people', trimmed],
    queryFn: async () => {
      const qs = trimmed ? `?search=${encodeURIComponent(trimmed)}&limit=50` : '?limit=200';
      const json = await bbbGet<{ data: PeopleRow[] }>(`/people${qs}`);
      return (json.data ?? []).map((row) => ({
        id: row.user.id,
        email: row.user.email,
        display_name: row.user.display_name,
        avatar_url: row.user.avatar_url,
      })) satisfies Person[];
    },
    staleTime: 1000 * 60 * 2,
  });
}

/**
 * A memo-friendly map of every visible person keyed by user id. Comments and
 * collaborators resolve their author/user names through this. Returns a Map
 * plus a helper that falls back to a short id when a name isn't resolvable.
 */
export function usePeopleMap() {
  const query = usePeople();
  const map = new Map<string, Person>();
  for (const p of query.data ?? []) map.set(p.id, p);
  return {
    ...query,
    map,
    nameFor: (userId: string | null | undefined): string => {
      if (!userId) return 'Unknown';
      const p = map.get(userId);
      if (p) return p.display_name || p.email;
      return `${userId.slice(0, 8)}…`;
    },
  };
}
