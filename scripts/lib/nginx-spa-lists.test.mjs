// node --test scripts/lib/nginx-spa-lists.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_FACING_INTERNAL,
  checkConfig,
  checkInternalDeny,
  launchpadPaths,
  parseLocations,
  selectLocation,
  servedSpas,
} from '../check-nginx-spa-lists.mjs';

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

// ─── Internal-route deny (#226) ─────────────────────────────────────────

const B3_DENY =
  'location ~* ^/b3/api/(?:v1/)?internal(?:/|$)(?!(?:system-errors/record-browser|helpdesk/queue|helpdesk/tickets/[^/]+(?:/messages)?)/?$) {\n    return 404;\n}';
const OTHER_DENY =
  'location ~* ^/(?:(?!b3/)[^/]+/api|helpdesk-api|mcp)/(?:v1/)?internal(?:/|$) {\n    return 404;\n}';
const proxies = [
  'location /b3/api/ {\n    proxy_pass http://api:4000/;\n}',
  'location /bastion/api/ {\n    set $u bastion-api:4024;\n    rewrite ^/bastion/api/(.*)$ /$1 break;\n    proxy_pass http://$u;\n}',
  'location /livekit-ws/ {\n    proxy_pass http://livekit:7880/;\n}',
].join('\n');

test('the shipped deny regexes leave no internal route reachable and keep browser routes open', () => {
  assert.deepEqual(checkInternalDeny('x.conf', [B3_DENY, OTHER_DENY, proxies].join('\n')), []);
});

test('a config with no deny is reported for every app proxy (the #226 bug), not for livekit', () => {
  const problems = checkInternalDeny('x.conf', proxies).join('\n');
  assert.match(problems, /\/b3\/api\/internal\/bastion\/tasks\/upsert reaches/);
  assert.match(problems, /\/bastion\/api\/v1\/internal\/probe reaches the upstream's internal route \/v1\/internal\/probe/);
  assert.doesNotMatch(problems, /livekit/);
});

test('a new app proxy without a deny is reported', () => {
  const onlyB3 = [B3_DENY, proxies, 'location /newapp/api/ {\n    proxy_pass http://newapp-api:4099/;\n}'].join('\n');
  assert.match(checkInternalDeny('x.conf', onlyB3).join('\n'), /\/newapp\/api\/internal\/probe reaches/);
});

test('a deny that swallows a browser-facing route is reported', () => {
  const blanket = 'location ~* ^/b3/api/internal/ {\n    return 404;\n}';
  const problems = checkInternalDeny('x.conf', [blanket, OTHER_DENY, proxies].join('\n')).join('\n');
  for (const uri of BROWSER_FACING_INTERNAL) assert.match(problems, new RegExp(`browser-facing ${uri.replace(/\//g, '\\/')} is denied`));
});

test('location selection: regex beats prefix, exact beats regex', () => {
  const locs = parseLocations([OTHER_DENY, 'location = /mcp/internal/x {\n    return 200;\n}', proxies].join('\n'));
  assert.equal(selectLocation(locs, '/bastion/api/v1/internal/events').body.includes('404'), true);
  assert.equal(selectLocation(locs, '/mcp/internal/x').mod, '=');
  assert.equal(selectLocation(locs, '/bastion/api/health').pattern, '/bastion/api/');
});
