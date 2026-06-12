import { describe, expect, it } from 'vitest';
import {
  buildLiveKitIdentity,
  extractUserIdFromLiveKitIdentity,
} from './index.js';

// These helpers are the production gate that keeps two concurrent
// sessions of the same user from kicking each other out of a LiveKit
// room with DUPLICATE_IDENTITY. The tests below pin the shape of the
// identity string — anything changing that shape needs a matching
// update on consumer code (banter-api webhook, bureau-client video
// tiles, future server-side reconcilers).

describe('buildLiveKitIdentity / extractUserIdFromLiveKitIdentity', () => {
  const USER_A = '65429e63-65c7-4f74-a19e-977217128edc';
  const USER_B = '20daae27-cd86-41c5-a64c-1113ba6bd750';

  it('round-trips: the extracted user_id matches the original', () => {
    const minted = buildLiveKitIdentity(USER_A);
    expect(extractUserIdFromLiveKitIdentity(minted)).toBe(USER_A);
  });

  it('produces a different identity for the same user on every call', () => {
    // This is the whole point of the helper — two sessions of the
    // same user must NOT collide.
    const a = buildLiveKitIdentity(USER_A);
    const b = buildLiveKitIdentity(USER_A);
    expect(a).not.toBe(b);
  });

  it('preserves the user_id prefix exactly so the room name routing still works', () => {
    const minted = buildLiveKitIdentity(USER_A);
    expect(minted.startsWith(`${USER_A}__`)).toBe(true);
  });

  it('keeps two different users routable to their own user_ids', () => {
    const a = buildLiveKitIdentity(USER_A);
    const b = buildLiveKitIdentity(USER_B);
    expect(extractUserIdFromLiveKitIdentity(a)).toBe(USER_A);
    expect(extractUserIdFromLiveKitIdentity(b)).toBe(USER_B);
  });

  it('returns legacy bare identities unchanged so in-flight rooms keep resolving', () => {
    // Legacy: pre-fix tokens minted with identity === user.id.
    expect(extractUserIdFromLiveKitIdentity(USER_A)).toBe(USER_A);
  });

  it('handles an empty string defensively', () => {
    expect(extractUserIdFromLiveKitIdentity('')).toBe('');
  });

  it('strips only the FIRST __ so a delimiter inside the suffix is safe', () => {
    // Belt-and-braces: if the random generator ever produced a chunk
    // containing `__`, we still keep the user prefix correct.
    expect(extractUserIdFromLiveKitIdentity(`${USER_A}__aa__bb`)).toBe(USER_A);
  });

  it('emits suffixes drawn from a wide enough alphabet to avoid collisions across many sessions', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(buildLiveKitIdentity(USER_A));
    }
    // No collisions across 1000 mints — entropy is well above the
    // birthday-paradox bound for our 4-byte suffix.
    expect(seen.size).toBe(1000);
  });
});
