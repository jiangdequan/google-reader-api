import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUser, ensureDefaultUsers, verifyPassword } from '../db/users.js';
import { sha256Hex } from '../util.js';
import { FakeDB } from './_fakedb.mjs';

test('createUser: random 16-hex salt, sha256 scheme stored; returns the stored row', async () => {
  let captured = null;
  const db = new FakeDB({
    onRun: (s) => {
      if (s.sql.includes('INSERT OR IGNORE INTO users')) captured = s.args;
      return { meta: { last_row_id: 5 } };
    },
    onFirst: (s) =>
      s.sql.includes('FROM users WHERE username') ? { id: 5, username: captured[0], password_hash: captured[1] } : null,
  });
  const row = await createUser({ DB: db }, 'alice', 'pw');

  assert.equal(row.username, 'alice');
  const [username, storedHash] = captured;
  const [scheme, salt, pwh] = storedHash.split(':');
  assert.equal(username, 'alice');
  assert.equal(scheme, 'sha256');
  assert.match(salt, /^[0-9a-f]{16}$/); // randomHex(8) -> 16 hex chars
  assert.equal(pwh, await sha256Hex(salt + ':' + 'pw'));
  assert.equal(row.password_hash, storedHash);
});

test('verifyPassword: success, wrong password, unknown user', async () => {
  const salt = 'abcd1234abcd1234';
  const good = {
    id: 1,
    username: 'alice',
    password_hash: 'sha256:' + salt + ':' + (await sha256Hex(salt + ':' + 'pw')),
  };
  // first lookup answers "no such user", afterwards return the stored row
  let seen = 0;
  const db = new FakeDB({ onFirst: () => (seen++ === 0 ? null : good) });
  assert.equal(await verifyPassword({ DB: db }, 'nobody', 'pw'), null);
  assert.equal((await verifyPassword({ DB: db }, 'alice', 'pw')).id, 1);
  assert.equal(await verifyPassword({ DB: db }, 'alice', 'nope'), null);
});

test('verifyPassword: rejects unknown scheme and missing fields', async () => {
  const mk = (password_hash) => ({ id: 2, username: 'u', password_hash });
  let row = mk('md5:' + 'salt:' + 'x');
  let db = new FakeDB({ onFirst: () => row });
  assert.equal(await verifyPassword({ DB: db }, 'u', 'x'), null);

  row = mk(null);
  db = new FakeDB({ onFirst: () => row });
  assert.equal(await verifyPassword({ DB: db }, 'u', 'x'), null);
});

test('verifyPassword: blank username or undefined password fails fast', async () => {
  const db = new FakeDB();
  assert.equal(await verifyPassword({ DB: db }, '', 'x'), null);
  assert.equal(await verifyPassword({ DB: db }, 'u', undefined), null);
  assert.equal(await verifyPassword({ DB: db }, 'u', null), null);
  assert.equal(db.plan.length, 0, 'no DB query for degenerate inputs');
});

test('ensureDefaultUsers: creates each missing user from GR_USERS', async () => {
  const created = [];
  const db = new FakeDB({
    onFirst: () => null, // nobody exists yet
    onRun: (s) => {
      if (s.sql.includes('INSERT OR IGNORE INTO users')) created.push(s.args[0]);
      return { meta: { last_row_id: 9 } };
    },
  });
  await ensureDefaultUsers({ DB: db, GR_USERS: 'alice:pw1,  bob:pw2' });
  assert.deepEqual(created, ['alice', 'bob']);
});

test('ensureDefaultUsers: skips malformed entries and existing users', async () => {
  const created = [];
  const existing = new Set(['alice']);
  const db = new FakeDB({
    onFirst: (s) => (s.sql.includes('SELECT id FROM users') ? (existing.has(s.args[0]) ? { id: 1 } : null) : null),
    onRun: (s) => {
      if (s.sql.includes('INSERT OR IGNORE INTO users')) created.push(s.args[0]);
      return { meta: { last_row_id: 9 } };
    },
  });
  await ensureDefaultUsers({ DB: db, GR_USERS: 'alice:pw,no-separator,bob:pw2,:nouser,,, carl: pw' });
  assert.deepEqual(created, ['bob', 'carl']);
});
