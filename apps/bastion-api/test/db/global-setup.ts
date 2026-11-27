import postgres from 'postgres';
import { installFaultTriggers, removeFaultTriggers } from './fault-injection.js';

// Runs once for the db project, before any DB-backed test file starts and after the last one ends
// (#320): the only DDL the suites need is done here, while nothing else is writing.
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  const started = Date.now();
  console.log('[bastion-api db globalSetup] installing the test fault-injection triggers...');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await installFaultTriggers(sql);
  } finally {
    await sql.end();
  }
  console.log(`[bastion-api db globalSetup] fault-injection triggers installed (${Date.now() - started} ms)`);
  return async () => {
    const down = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await removeFaultTriggers(down);
    } finally {
      await down.end();
    }
  };
}
