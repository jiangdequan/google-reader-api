import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authenticateRequest, clientLogin, issueToken, parseToken } from '../auth.js';
import { b64urlEncode, hmacHex, sha256Hex } from '../util.js';

const env = { JWT_SECRET: 'test-secret' };

function userDb(rows) {
  return {
    prepare() {
      return {
        bind(...args) {
          return {
            first: async () => rows.get(String(args[0])) ?? null,
          };
        },
      };
    },
  };
}

test('issueToken/parseToken roundtrip returns the user id', async () => {
  const tok = await issueToken(env, 42);
  assert.equal(typeof tok, 'string');
  assert.equal(tok.split('.').length, 2);
  assert.equal(await parseToken(env, tok), '42');
});

test('parseToken rejects a tampered signature', async () => {
  const tok = await issueToken(env, 42);
  const [payload] = tok.split('.');
  // Re-encode a changed payload so the signed bytes differ; the hmac then
  // cannot match.
  const tampered = b64urlEncode(atob(payload).replace('42', '43') || '');
  const [sig] = tok.split('.').reverse();
  assert.equal(await parseToken(env, `${tampered}.${sig}`), null);
});

test('parseToken rejects expired tokens', async () => {
  const payload = '7:' + (Math.floor(Date.now() / 1000) - 10);
  const sig = await hmacHex(env.JWT_SECRET, payload);
  const tok = b64urlEncode(payload) + '.' + b64urlEncode(sig);
  assert.equal(await parseToken(env, tok), null);
});

test('parseToken rejects garbage and partial tokens', async () => {
  assert.equal(await parseToken(env, ''), null);
  assert.equal(await parseToken(env, 'no-dot-here'), null);
  assert.equal(await parseToken(env, b64urlEncode('no-sig') + '.'), null);
});

test('parseToken rejects a different secret (cross-env token)', async () => {
  const tok = await issueToken({ JWT_SECRET: 'other-secret' }, 1);
  assert.equal(await parseToken(env, tok), null);
});

test('authenticateRequest: Bearer and ?auth= token paths', async () => {
  const okRow = { id: 42, username: 'alice' };
  const dbenv = { ...env, DB: userDb(new Map([['42', okRow]])) };
  const url = new URL('https://x/path?auth=' + encodeURIComponent(await issueToken(env, 42)));

  const bearer = new Request('https://x/path', {
    headers: { Authorization: 'Bearer ' + (await issueToken(env, 42)) },
  });
  assert.equal((await authenticateRequest(bearer, dbenv, url)).id, 42);

  assert.equal((await authenticateRequest(new Request('https://x/path'), dbenv, url)).id, 42);

  const absent = new Request('https://x/path', {
    headers: { Authorization: 'Bearer bad' },
  });
  assert.equal(await authenticateRequest(absent, dbenv, new URL('https://x/path')), null);
});

test('authenticateRequest: Basic username:password', async () => {
  const salt = 'abcd1234';
  const row = {
    username: 'alice',
    password_hash: 'sha256:' + salt + ':' + (await sha256Hex(salt + ':' + 'pw')),
  };
  const dbenv = { ...env, DB: userDb(new Map([['alice', row]])) };
  const basic = btoa('alice:pw');
  const req = new Request('https://x/', { headers: { Authorization: 'Basic ' + basic } });
  const user = await authenticateRequest(req, dbenv, new URL('https://x/'));
  assert.equal(user.username, 'alice');

  const wrong = new Request('https://x/', {
    headers: { Authorization: 'Basic ' + btoa('alice:nope') },
  });
  assert.equal(await authenticateRequest(wrong, dbenv, new URL('https://x/')), null);
});

test('clientLogin issues an Auth token for valid credentials', async () => {
  const salt = 'saltval';
  const row = {
    id: 9,
    username: 'alice',
    password_hash: 'sha256:' + salt + ':' + (await sha256Hex(salt + ':' + 'pw')),
  };
  const dbenv = { ...env, DB: userDb(new Map([['alice', { ...row, id: 9 }]])) };

  const req = new Request('https://x/accounts/ClientLogin', {
    method: 'POST',
    body: 'Email=alice&Passwd=pw',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const resp = await clientLogin(req, dbenv, new URL('https://x/accounts/ClientLogin'));
  assert.equal(resp.status, 200);
  assert.match(await resp.text(), /^SID=.+\nLSID=.+\nAuth=.+\n$/);

  const bad = await clientLogin(
    new Request('https://x/', { method: 'POST', body: 'Email=alice&Passwd=wrong' }),
    dbenv,
    new URL('https://x/'),
  );
  assert.equal(bad.status, 403);
});
