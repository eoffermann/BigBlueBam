/**
 * Helpers for calling the main Bam API (shared auth, projects, etc.)
 * Blueprint reuses Bam's session cookie so no extra headers are needed.
 */
const BAM_API = '/b3/api';

export async function bbbGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BAM_API}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Bam API error: ${res.status}`);
  return res.json();
}

export async function bbbPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BAM_API}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Bam API error: ${res.status}`);
  return res.json();
}
