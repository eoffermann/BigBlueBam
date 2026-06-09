import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { platformSettings } from '../db/schema/platform-settings.js';

const SINGLETON_ID = 1;

/** Returns the current platform-wide settings row (always id=1). */
export async function getPlatformSettings() {
  const rows = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, SINGLETON_ID))
    .limit(1);
  // The migration seeds the row, but fall through just in case.
  if (rows[0]) return rows[0];
  return {
    id: SINGLETON_ID,
    public_signup_disabled: false,
    helpdesk_signup_disabled: false,
    updated_at: new Date(),
    updated_by: null,
  };
}

/** Convenience accessor — used by the public Bam /auth/register gate. */
export async function isPublicSignupDisabled(): Promise<boolean> {
  const row = await getPlatformSettings();
  return row.public_signup_disabled === true;
}

/** Convenience accessor — used by the public Helpdesk /helpdesk/auth/register
 *  gate. Distinct from isPublicSignupDisabled so closing Bam signup during
 *  beta does not also lock end-customers out of filing tickets. */
export async function isHelpdeskSignupDisabled(): Promise<boolean> {
  const row = await getPlatformSettings();
  return row.helpdesk_signup_disabled === true;
}

/** SuperUser-only: flip the public_signup_disabled flag. */
export async function setPublicSignupDisabled(disabled: boolean, userId: string) {
  // Upsert by singleton id. The migration seeds the row; this ON CONFLICT
  // keeps the handler idempotent if a cluster somehow starts without it.
  await db
    .insert(platformSettings)
    .values({
      id: SINGLETON_ID,
      public_signup_disabled: disabled,
      updated_by: userId,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        public_signup_disabled: disabled,
        updated_by: userId,
        updated_at: sql`NOW()`,
      },
    });
}

/** SuperUser-only: flip the helpdesk_signup_disabled flag. */
export async function setHelpdeskSignupDisabled(disabled: boolean, userId: string) {
  await db
    .insert(platformSettings)
    .values({
      id: SINGLETON_ID,
      helpdesk_signup_disabled: disabled,
      updated_by: userId,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        helpdesk_signup_disabled: disabled,
        updated_by: userId,
        updated_at: sql`NOW()`,
      },
    });
}
