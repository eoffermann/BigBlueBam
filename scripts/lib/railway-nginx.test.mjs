// node --test scripts/lib/railway-nginx.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformNginxForRailway } from './railway-nginx.mjs';
import { REPO_ROOT } from './bolt-sources.mjs';

const hosts = {
  validHosts: ['api', 'bastion-api', 'bursar-api', 'minio', 'qdrant'],
  appHosts: ['api', 'bastion-api', 'bursar-api'],
};

const SOURCE = [
  'server {',
  '    __HTTP_LISTEN__',
  '    # Note: resolver 127.0.0.11 valid=10s; in a comment stays put',
  '    # set $bastion_api bastion-api:4024; in a comment stays put',
  '    location /bastion/api/ {',
  '        resolver 127.0.0.11 valid=10s ipv6=off;',
  '        set $bastion_api bastion-api:4024;',
  '        rewrite ^/bastion/api/(.*)$ /$1 break;',
  '        proxy_pass http://$bastion_api;',
  '    }',
  '    location /quoted/ {',
  '        set $q "bursar-api:4023";',
  '        proxy_pass http://$q;',
  '    }',
  '    location /files-store/ {',
  '        set $m minio:9000;',
  '        proxy_pass http://$m;',
  '    }',
  '    location /external/ {',
  '        set $ext example-host:1234;',
  '        proxy_pass http://$ext;',
  '    }',
  '    location /b3/api/ {',
  '        proxy_pass http://api:4000/;',
  '    }',
  '}',
  '',
].join('\r\n');

test('runtime-resolved `set $var host:port;` upstreams move to railway.internal', () => {
  const { out, counts } = transformNginxForRailway(SOURCE, hosts);
  assert.match(out, /^\s+set \$bastion_api bastion-api\.railway\.internal:8080;$/m);
  assert.match(out, /^\s+set \$q "bursar-api\.railway\.internal:8080";$/m);
  // Third-party images keep their own port.
  assert.match(out, /^\s+set \$m minio\.railway\.internal:9000;$/m);
  // Unknown hosts are left alone.
  assert.match(out, /^\s+set \$ext example-host:1234;$/m);
  assert.equal(counts.rewrittenSetUpstream, 3);
});

test('location-level `resolver 127.0.0.11` becomes the __RESOLVER__ placeholder', () => {
  const { out, counts } = transformNginxForRailway(SOURCE, hosts);
  assert.match(out, /^\s+resolver __RESOLVER__ valid=10s ipv6=off;$/m);
  assert.equal(counts.rewrittenResolver, 1);
  // Only the comment still mentions Docker's resolver.
  const live = out.split('\n').filter((l) => !/^\s*#/.test(l));
  assert.equal(live.filter((l) => l.includes('127.0.0.11')).length, 0);
});

test('comments are never rewritten', () => {
  const { out } = transformNginxForRailway(SOURCE, hosts);
  assert.ok(out.includes('# Note: resolver 127.0.0.11 valid=10s; in a comment stays put'));
  assert.ok(out.includes('# set $bastion_api bastion-api:4024; in a comment stays put'));
});

test('existing transforms still apply (listen, server resolver, static proxy_pass)', () => {
  const { out } = transformNginxForRailway(SOURCE, hosts);
  assert.match(out, /^ {4}listen 8080;\n {4}resolver __RESOLVER__ valid=10s;$/m);
  assert.match(out, /set \$rw_upstream_1 "api\.railway\.internal";/);
  assert.match(out, /rewrite \^\/b3\/api\/\(\.\*\)\$ \/\$1 break;/);
  assert.match(out, /proxy_pass http:\/\/\$rw_upstream_1:8080;/);
  assert.ok(!out.includes('\r'));
});

test('the committed nginx.railway.conf has no Docker resolver and no compose-only set upstream', () => {
  const conf = readFileSync(join(REPO_ROOT, 'infra', 'nginx', 'nginx.railway.conf'), 'utf8');
  const live = conf.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  assert.equal(live.filter((l) => /\bresolver\s+127\.0\.0\.11\b/.test(l)).length, 0);
  const composeSet = live.filter((l) => /^\s*set\s+\$\w+\s+["']?[a-z][a-z0-9-]*:\d+["']?\s*;/.test(l));
  assert.deepEqual(composeSet, []);
});
