#!/usr/bin/env node
/**
 * Workflow timeout guard (issue #235).
 *
 * Every job in .github/workflows/*.yml must set a job-level `timeout-minutes`. Without one a
 * hung runner holds its job for GitHub's 360-minute default and, through the concurrency group,
 * blocks the next push's run (a Typecheck job once hung 27 minutes until cancelled by hand).
 *
 * The parse is deliberately small (no YAML dependency): the top-level `jobs:` map, each job key
 * at two spaces, and a `timeout-minutes:` key at four spaces inside that job's block. A job that
 * reuses a workflow (`uses:` at job level) is exempt, since the called workflow's jobs carry
 * their own timeouts.
 *
 * Exit codes: 0 clean, 1 a job lacks timeout-minutes, 2 parse error.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './lib/bolt-sources.mjs';

const DIR = join(REPO_ROOT, '.github', 'workflows');

/** { jobs: [{ name, hasTimeout, reusable }] } for one workflow file's text, or null without jobs. */
export function workflowJobs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !/^#/.test(line)) break; // next top-level key
    const job = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (job) {
      cur = { name: job[1], hasTimeout: false, reusable: false };
      jobs.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^ {4}timeout-minutes:\s*\S/.test(line)) cur.hasTimeout = true;
    if (/^ {4}uses:\s*\S/.test(line)) cur.reusable = true;
  }
  return { jobs };
}

export function checkWorkflow(name, text) {
  const parsed = workflowJobs(text);
  if (!parsed) return { problems: [], parseError: `${name}: no top-level jobs: map found` };
  if (parsed.jobs.length === 0) return { problems: [], parseError: `${name}: jobs: has no jobs (parser out of date?)` };
  const problems = parsed.jobs
    .filter((j) => !j.hasTimeout && !j.reusable)
    .map((j) => `${name}: job '${j.name}' has no timeout-minutes (a hang would hold it for 360 minutes)`);
  return { problems, jobs: parsed.jobs.length };
}

function main() {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  const problems = [];
  let jobs = 0;
  for (const f of files) {
    const res = checkWorkflow(`.github/workflows/${f}`, readFileSync(join(DIR, f), 'utf8'));
    if (res.parseError) {
      console.error(`[workflow-timeouts] ${res.parseError}`);
      process.exit(2);
    }
    jobs += res.jobs;
    problems.push(...res.problems);
  }
  if (problems.length === 0) {
    console.log(`[workflow-timeouts] OK: all ${jobs} jobs in ${files.length} workflows set timeout-minutes`);
    process.exit(0);
  }
  for (const p of problems) console.error(`[workflow-timeouts] ${p}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
