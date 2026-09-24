import { test } from 'node:test';
import assert from 'node:assert/strict';

import { latestTimestamps } from '../db/subscriptions.js';
import { FakeDB } from './_fakedb.mjs';

test('latestTimestamps: dedupes ids, chunks IN queries, returns feed -> MAX(published)*1000', async () => {
  const inputs = [];
  for (let i = 0; i < 200; i++) inputs.push(i);
  inputs.push(5, 6); // dupes are deduped, not re-queried
  const found = new Set([3, 5, 199]);
  const db = new FakeDB({
    onAll: (s) => (s.args || []).filter((v) => found.has(Number(v))).map((v) => ({ feed_id: v, m: 9 })),
  });
  const map = await latestTimestamps({ DB: db }, inputs);

  // 200 distinct ids / 90 per statement => 3 chunked statements in one batch
  const stmts = db.batches[0];
  assert.equal(stmts.length, 3);
  assert.equal(
    stmts.reduce((n, s) => n + s.args.length, 0),
    200,
  );
  assert.equal(map[3], 9);
  assert.equal(map[5], 9);
  assert.equal(map[199], 9);
  assert.ok(!(4 in map), 'non-found feed id absent');
  // duplicate feeds appear once in the binds despite being in the input twice
  const flat = stmts.flatMap((s) => s.args);
  assert.equal(flat.filter((v) => v === 5).length, 1);
});

test('latestTimestamps: single id yields one IN query with that value bound', async () => {
  const db = new FakeDB();
  const map = await latestTimestamps({ DB: db }, [7]);
  assert.deepEqual(map, {});
  const stmts = db.batches[0];
  assert.equal(stmts.length, 1);
  assert.equal(
    stmts[0].sql,
    'SELECT feed_id, MAX(published)*1000 AS m FROM items WHERE feed_id IN (?) GROUP BY feed_id',
  );
  assert.deepEqual(stmts[0].args, [7]);
});

test('latestTimestamps: empty input never touches the DB', async () => {
  const db = new FakeDB();
  const map = await latestTimestamps({ DB: db }, []);
  assert.deepEqual(map, {});
  assert.equal(db.batches.length, 0);
  assert.equal(db.plan.length, 0);
});
