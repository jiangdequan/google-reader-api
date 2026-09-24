import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema } from '../db/schema.js';
import { FakeDB } from './_fakedb.mjs';

const schemaBatchHeaders = [
  'CREATE TABLE IF NOT EXISTS users',
  'CREATE TABLE IF NOT EXISTS feeds',
  'CREATE TABLE IF NOT EXISTS subscriptions',
  'CREATE TABLE IF NOT EXISTS tags',
  'CREATE TABLE IF NOT EXISTS subscription_tags',
  'CREATE TABLE IF NOT EXISTS items',
  'CREATE TABLE IF NOT EXISTS item_states',
  'CREATE TABLE IF NOT EXISTS item_tags',
  'CREATE INDEX IF NOT EXISTS idx_items_feed_pub',
  'CREATE INDEX IF NOT EXISTS idx_items_pub',
  'CREATE INDEX IF NOT EXISTS idx_states',
  'CREATE INDEX IF NOT EXISTS idx_item_tags',
  'CREATE INDEX IF NOT EXISTS idx_subtags',
];

test('ensureSchema: runs the schema batch once, no legacy keys -> no migration', async () => {
  const db = new FakeDB();
  await ensureSchema({ DB: db });
  for (const header of schemaBatchHeaders) {
    assert.ok(
      db.batches.some((b) => b.some((s) => s.sql.startsWith(header))),
      header,
    );
  }
  // exactly one schema batch, plus the legacy-key SELECT
  assert.equal(db.batches.length, 1);
  assert.equal(db.plan.filter((p) => p.op === 'all' && p.sql.includes("NOT LIKE 'tag:%'")).length, 1);
  assert.equal(db.runs('item_states').length, 0);
});

test('ensureSchema: schemaReady WeakMap dedupes per env', async () => {
  const db = new FakeDB();
  const env = { DB: db };
  await ensureSchema(env);
  await ensureSchema(env);
  assert.equal(db.batches.length, 1);
});

test('ensureSchema: migrates legacy decimal + hex rowids to tag ids', async () => {
  const db = new FakeDB({
    onAll: (s) => {
      if (s.sql.includes("NOT LIKE 'tag:%'")) return [{ item_id: '42' }, { item_id: '1a' }];
      if (s.sql.includes('FROM items WHERE rowid IN')) {
        return [
          { rowid: 42, id: 'tag:google.com,2005:reader/item/000000000000002a' },
          { rowid: 26, id: 'tag:google.com,2005:reader/item/000000000000001a' },
        ];
      }
      return [];
    },
  });
  await ensureSchema({ DB: db });

  // legacy lookups: 42 decimal, 0x1a = 26 hex
  const lookup = db.plan.find((p) => p.sql.includes('FROM items WHERE rowid IN'));
  assert.deepEqual(lookup.args, [42, 26]);

  const stmts = db.batches.flatMap((b) => b);
  const insStates = stmts.filter((s) => s.sql.startsWith('INSERT OR IGNORE INTO item_states'));
  assert.equal(insStates.length, 2);
  assert.deepEqual(insStates[0].args, ['tag:google.com,2005:reader/item/000000000000002a', '42']);
  assert.deepEqual(insStates[1].args, ['tag:google.com,2005:reader/item/000000000000001a', '1a']);

  const insTags = stmts.filter((s) => s.sql.startsWith('INSERT OR IGNORE INTO item_tags'));
  assert.equal(insTags.length, 2);
  assert.deepEqual(insTags[1].args, ['tag:google.com,2005:reader/item/000000000000001a', '1a']);

  const delStates = stmts.filter((s) => s.sql === 'DELETE FROM item_states WHERE item_id = ?');
  assert.deepEqual(
    delStates.map((s) => s.args),
    [['42'], ['1a']],
  );
  const delTags = stmts.filter((s) => s.sql === 'DELETE FROM item_tags WHERE item_id = ?');
  assert.deepEqual(
    delTags.map((s) => s.args),
    [['42'], ['1a']],
  );
});

test('ensureSchema: skips migration when the item id already matches the legacy key', async () => {
  const db = new FakeDB({
    onAll: (s) => {
      if (s.sql.includes("NOT LIKE 'tag:%'")) return [{ item_id: '42' }];
      if (s.sql.includes('FROM items WHERE rowid IN')) return [{ rowid: 42, id: '42' }];
      return [];
    },
  });
  await ensureSchema({ DB: db });
  const stmts = db.batches.flatMap((b) => b);
  assert.equal(stmts.filter((s) => s.sql.startsWith('INSERT OR IGNORE INTO item_states')).length, 0);
  assert.equal(stmts.filter((s) => s.sql.startsWith('DELETE FROM item_states')).length, 0);
});
