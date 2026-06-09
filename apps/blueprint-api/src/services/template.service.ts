import { eq, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blueprintTemplates } from '../db/schema/index.js';

export async function listTemplates(orgId: string) {
  return await db
    .select()
    .from(blueprintTemplates)
    .where(or(eq(blueprintTemplates.org_id, orgId), eq(blueprintTemplates.is_system, true)));
}

export async function getTemplate(templateId: string) {
  const [row] = await db
    .select()
    .from(blueprintTemplates)
    .where(eq(blueprintTemplates.id, templateId))
    .limit(1);
  return row ?? null;
}
