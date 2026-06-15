import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bondUserSettings } from '../db/schema/bond-user-settings.js';

export interface BondUserSettings {
  user_id: string;
  reply_to_email: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

/** Current user's Bond settings, or a zero-value row if none is stored yet. */
export async function getUserSettings(userId: string): Promise<BondUserSettings> {
  const [row] = await db
    .select()
    .from(bondUserSettings)
    .where(eq(bondUserSettings.user_id, userId))
    .limit(1);
  return (
    row ?? { user_id: userId, reply_to_email: null, created_at: null, updated_at: null }
  );
}

/** Upsert the user's Bond settings (one row per user, keyed on user_id). */
export async function updateUserSettings(
  userId: string,
  data: { reply_to_email: string | null },
): Promise<BondUserSettings> {
  const [row] = await db
    .insert(bondUserSettings)
    .values({ user_id: userId, reply_to_email: data.reply_to_email })
    .onConflictDoUpdate({
      target: bondUserSettings.user_id,
      set: { reply_to_email: data.reply_to_email, updated_at: new Date() },
    })
    .returning();
  return row!;
}
