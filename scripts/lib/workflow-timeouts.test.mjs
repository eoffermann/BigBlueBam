// node --test scripts/lib/workflow-timeouts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkflow, workflowJobs } from '../check-workflow-timeouts.mjs';

const wf = (jobs) => ['name: x', 'on:', '  push:', 'jobs:', ...jobs, 'permissions: {}'].join('\n');

test('a job with timeout-minutes passes; one without is reported (the #235 hang)', () => {
  const text = wf([
    '  a:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    steps:',
    '      - run: echo',
    '        timeout-minutes: 5',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: step-level only',
    '        timeout-minutes: 5',
  ]);
  const { problems } = checkWorkflow('w.yml', text);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /job 'b' has no timeout-minutes/);
});

test('a reusable-workflow job is exempt; jobs end at the next top-level key', () => {
  const parsed = workflowJobs(wf(['  call:', '    uses: ./.github/workflows/other.yml']));
  assert.deepEqual(parsed.jobs, [{ name: 'call', hasTimeout: false, reusable: true }]);
  assert.deepEqual(checkWorkflow('w.yml', wf(['  call:', '    uses: ./x.yml'])).problems, []);
});

test('a file with no jobs is a parse error, never a silent pass', () => {
  assert.ok(checkWorkflow('w.yml', 'name: x\non: push\n').parseError);
});
