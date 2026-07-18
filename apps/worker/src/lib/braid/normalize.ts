// Match-key normalization (spec 4.1). Byte-faithful copy of
// apps/braid-api/src/lib/normalize.ts (the worker follows the no-cross-api-import
// convention). Produces { email_norm, phone_norm, name_norm, domain }. Keep in sync
// with braid-api's copy so the engine and the resolve path normalize identically.

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
]);

export interface NormalizedMatchKeys {
  email_norm?: string;
  phone_norm?: string;
  name_norm?: string;
  domain?: string;
}

export interface RawMatchInput {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export function normalizeEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return undefined;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (FREE_MAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
  }
  return `${local}@${domain}`;
}

export function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < 7) return undefined;
  return hasPlus ? `+${digits}` : digits;
}

export function normalizeName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const folded = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return folded.length > 0 ? folded : undefined;
}

export function normalizeDomain(raw: string | null | undefined): string | undefined {
  const email = normalizeEmail(raw);
  if (!email) return undefined;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (FREE_MAIL_DOMAINS.has(domain)) return undefined;
  return domain;
}

export function normalizeMatchKeys(raw: RawMatchInput): NormalizedMatchKeys {
  const name = raw.name ?? ([raw.first_name, raw.last_name].filter(Boolean).join(' ') || null);
  const out: NormalizedMatchKeys = {};
  const email = normalizeEmail(raw.email);
  const phone = normalizePhone(raw.phone);
  const nameNorm = normalizeName(name);
  const domain = normalizeDomain(raw.email);
  if (email) out.email_norm = email;
  if (phone) out.phone_norm = phone;
  if (nameNorm) out.name_norm = nameNorm;
  if (domain) out.domain = domain;
  return out;
}
