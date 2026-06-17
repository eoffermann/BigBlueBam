// ---------------------------------------------------------------------------
// bond_upsert_contact service (AGENTIC_TODO §14 Wave 4)
//
// Idempotent create-or-update on (organization_id, lower(email)). Natural
// key is backed by the partial unique index
// `bond_contacts_org_lower_email_uniq` from migration 0130 (WHERE email IS
// NOT NULL AND deleted_at IS NULL).
//
// Soft-delete resurrection: if the pre-check finds an existing row with
// `deleted_at IS NOT NULL`, the update path clears it so the contact comes
// back to life. This matches webhook intent (webhooks don't know we soft-
// deleted this contact; re-receiving the same email should restore it).
//
// Returns the full contact row, a `created` boolean (for log attribution),
// and an idempotency_key string the caller can echo back into logs.
// ---------------------------------------------------------------------------

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bondContacts } from '../db/schema/index.js';
import { badRequest } from '../lib/utils.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { loadActor, loadOrg, contactUrl } from '../lib/bolt-enrichment.js';

export interface ContactUpsertInput {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  title?: string;
  avatar_url?: string;
  lifecycle_stage?: string;
  lead_source?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state_region?: string;
  postal_code?: string;
  country?: string;
  custom_fields?: Record<string, unknown>;
  owner_id?: string;
}

export interface ContactUpsertResult {
  data: typeof bondContacts.$inferSelect;
  created: boolean;
  idempotency_key: string;
}

/**
 * Upsert a Bond contact by (organization_id, lower(email)).
 *
 * The email is required and is lower-cased before comparison: the underlying
 * partial unique index is on `lower(email)`, so case variation in the input
 * (`Ada@Acme.COM` vs `ada@acme.com`) still hits the same row.
 *
 * The caller is responsible for authz (route-level) and for passing the
 * acting user id. The `created_by` column on insert is set to the acting
 * user; on update it is left unchanged.
 */
export async function upsertContactByEmail(
  input: ContactUpsertInput,
  orgId: string,
  actingUserId: string,
): Promise<ContactUpsertResult> {
  if (!input.email || input.email.trim() === '') {
    throw badRequest('email is required for bond_upsert_contact');
  }
  const normalizedEmail = input.email.trim();
  const lowerEmail = normalizedEmail.toLowerCase();

  // Pre-check: do we have an existing row (including soft-deleted)? The
  // partial unique index excludes soft-deleted rows, so a plain ON CONFLICT
  // would insert a second row next to a soft-deleted one. We explicitly
  // handle soft-delete resurrection below.
  const [existing] = await db
    .select()
    .from(bondContacts)
    .where(
      and(
        eq(bondContacts.organization_id, orgId),
        sql`lower(${bondContacts.email}) = ${lowerEmail}`,
      ),
    )
    .limit(1);

  if (existing) {
    // Soft-delete resurrection: if the matching row is soft-deleted,
    // revive it and apply the incoming fields. Webhooks don't know about
    // soft delete, so re-receiving the same contact should re-create it.
    const wasSoftDeleted = existing.deleted_at !== null;

    const updateValues: Record<string, unknown> = {
      updated_at: new Date(),
    };
    if (wasSoftDeleted) updateValues.deleted_at = null;
    if (input.first_name !== undefined) updateValues.first_name = input.first_name;
    if (input.last_name !== undefined) updateValues.last_name = input.last_name;
    // Always store the incoming email as-provided so display case is
    // preserved; the unique index is on lower(email) so this is safe.
    updateValues.email = normalizedEmail;
    if (input.phone !== undefined) updateValues.phone = input.phone;
    if (input.title !== undefined) updateValues.title = input.title;
    if (input.avatar_url !== undefined) updateValues.avatar_url = input.avatar_url;
    if (input.lifecycle_stage !== undefined) updateValues.lifecycle_stage = input.lifecycle_stage;
    if (input.lead_source !== undefined) updateValues.lead_source = input.lead_source;
    if (input.address_line1 !== undefined) updateValues.address_line1 = input.address_line1;
    if (input.address_line2 !== undefined) updateValues.address_line2 = input.address_line2;
    if (input.city !== undefined) updateValues.city = input.city;
    if (input.state_region !== undefined) updateValues.state_region = input.state_region;
    if (input.postal_code !== undefined) updateValues.postal_code = input.postal_code;
    if (input.country !== undefined) updateValues.country = input.country;
    if (input.custom_fields !== undefined) updateValues.custom_fields = input.custom_fields;
    if (input.owner_id !== undefined) updateValues.owner_id = input.owner_id;

    const [updated] = await db
      .update(bondContacts)
      .set(updateValues)
      .where(eq(bondContacts.id, existing.id))
      .returning();

    const result = updated!;
    void publishContactUpserted(result, actingUserId, orgId, false);

    return {
      data: result,
      created: false,
      idempotency_key: `email:${lowerEmail}`,
    };
  }

  // Insert path. Use ON CONFLICT with the partial unique index as a race
  // guard: if a parallel writer inserted the same (org, lower(email))
  // between our pre-check and this statement, the conflict branch produces
  // a deterministic row (we bump updated_at and overwrite email). The
  // `xmax = 0` projection tells us which branch fired.
  //
  // This is issued as raw SQL rather than Drizzle's `onConflictDoUpdate`
  // builder: the builder's `target` only accepts column references, so the
  // earlier `sql\`lower(email)\` as unknown as PgColumn` cast serialized the
  // conflict target to the literal `"undefined"` and every upsert crashed
  // with `column "undefined" does not exist`. Naming the partial index
  // predicate verbatim here matches `bond_contacts_org_lower_email_uniq`.
  const inserted = await db.execute(sql`
    INSERT INTO bond_contacts (
      organization_id, first_name, last_name, email, phone, title, avatar_url,
      lifecycle_stage, lead_source, address_line1, address_line2, city,
      state_region, postal_code, country, custom_fields, owner_id, created_by
    ) VALUES (
      ${orgId}, ${input.first_name ?? null}, ${input.last_name ?? null},
      ${normalizedEmail}, ${input.phone ?? null}, ${input.title ?? null},
      ${input.avatar_url ?? null}, ${input.lifecycle_stage ?? 'lead'},
      ${input.lead_source ?? null}, ${input.address_line1 ?? null},
      ${input.address_line2 ?? null}, ${input.city ?? null},
      ${input.state_region ?? null}, ${input.postal_code ?? null},
      ${input.country ?? null}, ${JSON.stringify(input.custom_fields ?? {})}::jsonb,
      ${input.owner_id ?? actingUserId}, ${actingUserId}
    )
    ON CONFLICT (organization_id, lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL
    DO UPDATE SET email = ${normalizedEmail}, updated_at = now()
    RETURNING *, (xmax = 0) AS created
  `);

  const rows = inserted as unknown as Array<
    typeof bondContacts.$inferSelect & { created: boolean }
  >;
  const row = rows[0];
  if (!row) {
    throw badRequest('upsert returned no row');
  }
  const { created: createdFlag, ...contactRow } = row;
  const result = contactRow as typeof bondContacts.$inferSelect;
  const created = createdFlag === true;

  void publishContactUpserted(result, actingUserId, orgId, created);

  return {
    data: result,
    created,
    idempotency_key: `email:${lowerEmail}`,
  };
}

async function publishContactUpserted(
  contact: typeof bondContacts.$inferSelect,
  actingUserId: string,
  orgId: string,
  created: boolean,
): Promise<void> {
  try {
    const [actor, org] = await Promise.all([loadActor(actingUserId), loadOrg(orgId)]);
    await publishBoltEvent(
      'contact.upserted',
      'bond',
      {
        contact: {
          id: contact.id,
          email: contact.email,
          organization_id: contact.organization_id,
          first_name: contact.first_name,
          last_name: contact.last_name,
          lifecycle_stage: contact.lifecycle_stage,
          owner_id: contact.owner_id,
          url: contactUrl(contact.id),
        },
        created,
        actor: actor
          ? {
              id: actor.id,
              name: actor.name,
              email: actor.email,
              // `kind` is a bare Bolt-event hint (user/system/agent); the
              // enrichment loader here does not join users.kind yet so we
              // default to 'user' — the Wave 0.4 publishBoltEvent wrapper
              // also attaches actor_type at the envelope level.
              kind: 'user',
            }
          : { id: actingUserId, kind: 'user' },
        org: org ? { id: org.id, name: org.name, slug: org.slug } : { id: orgId },
      },
      orgId,
      actingUserId,
      'user',
    );
  } catch {
    // Fire-and-forget.
  }
}
