/** The generic e2e admin, who lives in the throwaway "E2E Test Organization". */
export const DEFAULT_E2E_ADMIN_EMAIL = 'e2e-admin@bigbluebam.test';

export const TEST_USERS = {
  admin: {
    email: process.env.E2E_ADMIN_EMAIL || DEFAULT_E2E_ADMIN_EMAIL,
    password: process.env.E2E_ADMIN_PASSWORD || 'E2eTestP@ss123!',
    displayName: 'E2E Admin',
    orgName: process.env.E2E_ORG_NAME || 'E2E Test Organization',
  },
  member: {
    email: process.env.E2E_MEMBER_EMAIL || 'e2e-member@bigbluebam.test',
    password: process.env.E2E_MEMBER_PASSWORD || 'E2eTestP@ss123!',
    displayName: 'E2E Member',
  },
} as const;

export type TestUserRole = keyof typeof TEST_USERS;

/**
 * Whether the "seed e2e ..." setup steps may write their generic placeholder data (#249). They
 * write into the admin's org, so they run only for the generic e2e admin. A run that signs in as a
 * real sample-data identity (E2E_ADMIN_EMAIL=skipper@gilligantravel.example for the bastion
 * project or screenshots) must never pollute that curated org (CLAUDE.md GILLIGAN rule).
 * E2E_SEED_GENERIC_DATA=1 forces seeding for a custom admin in a throwaway org.
 */
export const GENERIC_SEED_ALLOWED =
  TEST_USERS.admin.email.toLowerCase() === DEFAULT_E2E_ADMIN_EMAIL || process.env.E2E_SEED_GENERIC_DATA === '1';
