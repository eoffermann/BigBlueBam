// node --test scripts/lib/nginx-spa-lists.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, launchpadPaths, servedSpas } from '../check-nginx-spa-lists.mjs';

const conf = (indexList, assetsList) =>
  [
    'location /b3/ {',
    '    try_files $uri $uri/ /b3/index.html;',
    '}',
    'location /bursar/ {',
    '    try_files $uri $uri/ /bursar/index.html;',
    '}',
    '# try_files $uri $uri/ /commented/index.html;',
    `location ~* ^/(${indexList})/index\\.html$ {`,
    '}',
    `location ~* ^/(${assetsList})/assets/.*\\.(js|css)$ {`,
    '}',
  ].join('\n');

test('served SPAs come from try_files fallbacks, ignoring comments', () => {
  assert.deepEqual([...servedSpas(conf('b3', 'b3'))].sort(), ['b3', 'bursar']);
});

test('a served SPA missing from the index.html regex is reported (the #127 bug)', () => {
  const { problems } = checkConfig('x.conf', conf('b3', 'b3|bursar'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /index\.html no-cache regex is missing served SPA\(s\): bursar/);
});

test('a regex naming an SPA the config does not serve is reported', () => {
  const { problems } = checkConfig('x.conf', conf('b3|bursar|ghost', 'b3|bursar'));
  assert.match(problems.join('\n'), /does not serve: ghost/);
});

test('matching lists are clean', () => {
  assert.deepEqual(checkConfig('x.conf', conf('b3|bursar', 'bursar|b3')).problems, []);
});

test('launchpad paths parse', () => {
  assert.deepEqual(launchpadPaths("{ id: 'b3', path: '/b3/' }, { id: 'x', path: '/bursar/' }"), ['b3', 'bursar']);
});
