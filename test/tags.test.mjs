import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTag } from '../api/stream-parser.js';
import { FakeDB } from './_fakedb.mjs';

const DB = (opts = {}) => new FakeDB({ onAll: (s) => (s.sql.includes('AS feed_url') ? [] : []), ...opts });
const USER = { id: 7 };
const ITEM = 'tag:google.com,2005:reader/item/0000000000000001';

const rows = async (db, insertInto, sel, del) => (db.runs(insertInto).length > 0 ? '' : '');

test('applyTag: read on inserts read and clears kept-unread', async () => {
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/read', true);
  const runs = db.plan.filter((p) => p.op === 'run');
  assert.deepEqual(
    runs.map((r) => [r.sql, r.args]),
    [
      ['INSERT OR IGNORE INTO item_states(user_id, item_id, state) VALUES (?,?,?)', [7, ITEM, 'read']],
      ['DELETE FROM item_states WHERE user_id=? AND item_id=? AND state=?', [7, ITEM, 'kept-unread']],
    ],
  );
});

test('applyTag: read off deletes read only', async () => {
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/read', false);
  const runs = db.plan.filter((p) => p.op === 'run');
  assert.deepEqual(
    runs.map((r) => r.sql),
    ['DELETE FROM item_states WHERE user_id=? AND item_id=? AND state=?'],
  );
  assert.deepEqual(runs[0].args, [7, ITEM, 'read']);
});

test('applyTag: unread is the inverse of read', async () => {
  let db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/unread', true);
  assert.equal(db.runs('item_states')[0].args[2], 'read'); // DELETE read
  db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/unread', false);
  assert.deepEqual(db.runs('item_states')[0].args, [7, ITEM, 'read']); // INSERT read
});

test('applyTag: kept-unread on clears read then sets kept-unread', async () => {
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/kept-unread', true);
  const stmts = db.plan.filter((p) => p.op === 'run').map((p) => [p.args[2], p.sql.startsWith('INSERT')]);
  assert.deepEqual(stmts, [
    ['read', false],
    ['kept-unread', true],
  ]);
});

test('applyTag: kept-unread off deletes kept-unread only', async () => {
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/kept-unread', false);
  const runs = db.plan.filter((p) => p.op === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, [7, ITEM, 'kept-unread']);
  assert.ok(runs[0].sql.startsWith('DELETE'));
});

test('applyTag: starred/broadcast on/off round-trip', async () => {
  for (const state of ['starred', 'broadcast']) {
    for (const on of [true, false]) {
      const db = DB();
      await applyTag({ DB: db }, USER, ITEM, `user/-/state/com.google/${state}`, on);
      const runs = db.plan.filter((p) => p.op === 'run');
      assert.equal(runs.length, 1, `${state} ${on}`);
      const [sql, args] = [runs[0].sql, runs[0].args];
      assert.deepEqual(args, [7, ITEM, state]);
      assert.ok(on ? sql.startsWith('INSERT') : sql.startsWith('DELETE'));
    }
  }
});

test('applyTag: com.google/tracking-* states are ignored', async () => {
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/tracking/bubble', true);
  await applyTag({ DB: db }, USER, ITEM, 'user/-/state/com.google/tracking-foo', false);
  assert.equal(db.plan.filter((p) => p.op === 'run').length, 0);
});

test('applyTag: feed and unknown terms are no-ops', async () => {
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'feed/https://x.com/f', true);
  await applyTag({ DB: db }, USER, ITEM, 'user/-/nonsense/thing', true);
  await applyTag({ DB: db }, USER, ITEM, '  ', true);
  assert.equal(db.plan.filter((p) => p.op === 'run').length, 0);
});

test('applyTag: label term (canonical, bare, label-with-prefix) inserts/deletes item_tags', async () => {
  for (const term of ['user/-/label/dev', 'user/5/label/dev', 'dev']) {
    const db = DB();
    await applyTag({ DB: db }, USER, ITEM, term, true);
    const runs = db.plan.filter((p) => p.op === 'run');
    assert.equal(runs.length, 1, term);
    assert.ok(runs[0].sql.startsWith('INSERT OR IGNORE INTO item_tags'));
    assert.deepEqual(runs[0].args, [7, ITEM, 'dev']);
  }
  const db = DB();
  await applyTag({ DB: db }, USER, ITEM, 'user/-/label/dev', false);
  const run = db.plan.filter((p) => p.op === 'run')[0];
  assert.ok(run.sql.startsWith('DELETE FROM item_tags'));
  assert.deepEqual(run.args, [7, ITEM, 'dev']);
});

test('applyTag: resolved item row replaces a bare id with its canonical tag', async () => {
  const found = {
    rowid: 1,
    id: ITEM,
    title: 'x',
    content: '',
    url: '',
    published: 0,
    timestamp_usec: '0',
    feed_url: 'https://f.com',
    feed_title: 'F',
    feed_html: 'https://f.com',
  };
  const db = new FakeDB({ onAll: (s) => (s.sql.includes('AS feed_url') ? [found] : []) });
  await applyTag({ DB: db }, USER, '123', 'user/-/state/com.google/starred', true);
  const run = db.plan.filter((p) => p.op === 'run')[0];
  assert.deepEqual(run.args, [7, ITEM, 'starred']);
});
