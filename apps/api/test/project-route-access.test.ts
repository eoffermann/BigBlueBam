import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every api route under /projects/:id must prove the caller belongs to that
// project in the same org before it touches project data. The list/read
// routes carried requireProjectAccess(); the create routes beside them (tasks,
// sprints, phases, labels, epics, custom fields, views, task templates, the
// Trello/Jira/GitHub importers) and the Slack/GitHub integration routes did
// not, so a read_write user of one org could create tasks in, or read and
// overwrite the Slack webhook of, any other org's project by UUID.
//
// This reads the route files so a new project-scoped route without the guard
// fails here. Exceptions must say where the equivalent check lives.

const ROUTES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'routes');

const EXCEPTIONS: Record<string, string> = {
  // Membership (and the admin role where needed) is checked inside each handler.
  'project.routes.ts GET /projects/:id': 'handler checks membership',
  'project.routes.ts PATCH /projects/:id': 'handler checks project admin',
  'project.routes.ts DELETE /projects/:id': 'handler checks project admin',
  'project.routes.ts GET /projects/:id/members': 'handler checks membership',
  'project.routes.ts POST /projects/:id/members': 'handler checks project admin',
};

const ROUTE = /fastify\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*'(\/projects\/:(?:id|projectId)[^']*)'/g;

function unguarded(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    for (const m of src.matchAll(ROUTE)) {
      const asyncAt = src.indexOf('async', m.index);
      const opts = src.slice(m.index, asyncAt);
      if (/requireProject(Access|Role)\(/.test(opts)) continue;
      const key = `${file} ${m[1]!.toUpperCase()} ${m[2]}`;
      if (!(key in EXCEPTIONS)) out.push(key);
    }
  }
  return out;
}

describe('project-scoped api routes', () => {
  it('find the project routes at all', () => {
    const src = readFileSync(join(ROUTES, 'task.routes.ts'), 'utf8');
    expect([...src.matchAll(ROUTE)].length).toBeGreaterThan(2);
  });

  it('every /projects/:id route carries requireProjectAccess or a documented exception', () => {
    expect(unguarded()).toEqual([]);
  });
});
