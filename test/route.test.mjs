import { test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../index.js';
import { issueToken } from '../auth.js';
import { FakeDB } from './_fakedb.mjs';

const USER = { id: 1, username: 'alice', password_hash: 'sha256:x:y', created_at: 0 };

// Auth must always resolve; every other query is empty data — a handler mis-
// routed to the DB layer would then crash or 404, which the asserts below catch.
function makeEnv() {
  const DB = new FakeDB({
    onFirst: (s) => (s.sql.includes(' FROM users ') ? USER : null),
  });
  return { DB, JWT_SECRET: 'test-secret' };
}

function req(pathAndQuery = '', init = {}) {
  return new Request('https://reader.example' + pathAndQuery, init);
}

async function authed(pathAndQuery = '', init = {}) {
  const r = req(pathAndQuery, init);
  return new Request(r.url, {
    method: r.method,
    headers: { Authorization: 'Bearer ' + (await issueToken({ JWT_SECRET: 'test-secret' }, USER.id)), ...init.headers },
  });
}

// Map the dispatch table exactly like index.js so a new endpoint is caught both
// in the refactor risk and in this list.
const GET_ENDPOINTS = [
  ['stream/contents', '?s=user/-/state/com.google/reading-list'],
  ['stream/items/ids', '?s=user/-/state/com.google/reading-list'],
  ['stream/items/contents', '?s=user/-/state/com.google/reading-list'],
  ['stream/items/count', '?s=user/-/state/com.google/reading-list'],
  ['stream/details', '?s=user/-/state/com.google/reading-list'],
  ['user-info', ''],
  ['unread-count', ''],
  ['subscription/list', ''],
  ['subscription/quickadd', '?quickadd=https://quick.com/rss'],
  ['subscription/edit', '?s=https://e.com&a=user/-/label/L'],
  ['subscription/delete', '?s=https://e.com'],
  ['tag/list', ''],
  ['rename-tag', '?s=user/-/label/x&dest=user/-/label/y'],
  ['disable-tag', '?s=user/-/label/x'],
  ['edit-tag', '?s=user/-/state/com.google/like&a=user/-/label/k'],
  ['mark-all-as-read', '?s=user/-/state/com.google/reading-list'],
  ['preference/list', ''],
  ['preference/stream/list', ''],
  ['friend/list', ''],
  ['search/items/ids', '?q=abc'],
];

test('GET / without auth serves info', async () => {
  const resp = await route(req('/'), makeEnv(), {});
  assert.equal(resp.status, 200);
});

test('ClientLogin reaches auth before the reader gate', async () => {
  const resp = await route(req('/accounts/ClientLogin', { method: 'POST' }), makeEnv(), {});
  assert.equal(resp.status, 403); // no credentials -> bad auth, not 401 page
});

test('unauthenticated reader request is intercepted with 401', async () => {
  const resp = await route(req('/reader/api/0/user-info'), makeEnv(), {});
  assert.equal(resp.status, 401);
  assert.equal(await resp.text(), 'Error=AuthRequired');
});

test('unknown endpoint returns the not-found JSON', async () => {
  const resp = await route(await authed('/reader/api/0/no-such-endpoint'), makeEnv(), {});
  assert.equal(resp.status, 404);
  assert.deepEqual(await resp.json(), { error: 'unknown endpoint', path: '/reader/api/0/no-such-endpoint' });
});

test('non-reader paths are rejected before the endpoint map', async () => {
  const resp = await route(await authed('/reader/definitely-not-an-api'), makeEnv(), {});
  assert.equal(resp.status, 404);
  assert.deepEqual(await resp.json(), { error: 'not found', path: '/reader/definitely-not-an-api' });
});

test('auth token issues for a valid user', async () => {
  const resp = await route(await authed('/reader/api/0/token'), makeEnv(), {});
  assert.equal(resp.status, 200);
  const t = await resp.text();
  assert.ok(t.length > 10);
  assert.ok(/^[A-Za-z0-9_.+-=]+$/.test(t)); // opaque opaque-legacy token string
});

test('every endpoint in the dispatch map is reachable (not "unknown endpoint")', async (t) => {
  // subscription/quickadd subscribes by fetching the feed — stub out the network.
  t.mock.method(globalThis, 'fetch', () => new Response('', { status: 404 }));
  for (const [key, qs] of GET_ENDPOINTS) {
    const resp = await route(await authed('/reader/api/0/' + key + qs), makeEnv(), {});
    const body = await resp
      .clone()
      .json()
      .catch(() => null);
    assert.notEqual(body && body.error, 'unknown endpoint', key + ' fell through the dispatch table');
    assert.ok(resp.status >= 200 && resp.status < 500, key + ' returned ' + resp.status);
  }
});

test('/reader/atom/ routes to the stream handler', async () => {
  const resp = await route(await authed('/reader/atom/user/-/state/com.google/binary/under-the-bridge'), makeEnv(), {});
  const body = await resp
    .clone()
    .json()
    .catch(() => null);
  assert.notEqual(body && body.error, 'unknown endpoint');
  assert.equal(resp.status, 200);
});

test('user-info resolves the authenticated identity from the token', async () => {
  const resp = await route(await authed('/reader/api/0/user-info'), makeEnv(), {});
  const j = await resp.json();
  assert.equal(j.userId, '1');
  assert.equal(j.userName, 'alice');
});
