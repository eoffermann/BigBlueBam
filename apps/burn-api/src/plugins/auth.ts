// burn-api authentication: session cookie, bbam_ API key, org context and SuperUser
// impersonation are @bigbluebam/auth-core's shared satellite plugin (#369). This file only
// binds it to this service's db, drizzle sql tag and argon2; do not add auth logic here
// (scripts/lib/auth-core-single-source.test.mjs enforces it).
import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import '@bigbluebam/auth-core/fastify-request';
import { createSatelliteAuth } from '@bigbluebam/auth-core';
import { db } from '../db/index.js';

const auth = createSatelliteAuth({
  sql,
  execute: (query) => db.execute(query),
  verifyHash: (hash, token) => argon2.verify(hash, token),
});

export default fp(auth.plugin, { name: 'auth', dependencies: ['@fastify/cookie'] });
export const requireAuth = auth.requireAuth;
export const buildAuthUser = auth.buildAuthUser;

// requireScope is the one gate every service uses (#340); the rest keep existing importers working.
export {
  isApiKeyOrgPinned,
  type OrgMembership,
  OrgMembershipError,
  requireScope,
  type SatelliteAuthUser as AuthUser,
} from '@bigbluebam/auth-core';
