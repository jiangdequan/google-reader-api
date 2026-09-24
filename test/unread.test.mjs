import { test } from 'node:test';
import assert from 'node:assert/strict';

import { feedUnread, labelUnread, readingListUnread, starredUnread } from '../db/unread.js';
import { FakeDB } from './_fakedb.mjs';

const envFor = (db) => ({ DB: db });
const sqlOf = (db, sub) => db.plan.filter((p) => p.op === 'all' && p.sql.includes(sub));

test('unread: subscribed + notRead AND-combine with bound user ids', async () => {
  const db = new FakeDB({ onAll: () => ['x'] });
  const out = await feedUnread(envFor(db), 9);
  assert.deepEqual(out, ['x']);
  const q = sqlOf(db, 'feed_url')[0];
  assert.match(q.sql, /FROM items i\s+JOIN feeds f ON f\.id = i\.feed_id\s+WHERE /s);
  assert.match(q.sql, /EXISTS \(SELECT 1 FROM subscriptions su WHERE su\.user_id=\? AND su\.feed_id=i\.feed_id\)/);
  assert.match(
    q.sql,
    /AND NOT EXISTS \(SELECT 1 FROM item_states s WHERE s\.user_id=\? AND s\.item_id=i\.id AND s\.state='read'\)/,
  );
  assert.deepEqual(q.args, [9, 9]);
});

test('unread: label scope joins subscription_tags + tags then notRead', async () => {
  const db = new FakeDB({ onAll: () => [] });
  const out = await labelUnread(envFor(db), 3);
  assert.deepEqual(out, []);
  const q = sqlOf(db, 'GROUP BY t.name')[0];
  assert.match(q.sql, /JOIN subscription_tags st ON st\.feed_id = i\.feed_id AND st\.user_id = \?/);
  assert.match(q.sql, /JOIN tags t ON t\.id = st\.tag_id AND t\.user_id = \?/);
  assert.match(q.sql, /GROUP BY t\.name/);
  assert.deepEqual(q.args, [3, 3, 3]);
});

test('unread: reading-list count + latest max', async () => {
  const db = new FakeDB({ onFirst: () => ({ c: 7, m: 1234 }) });
  const out = await readingListUnread(envFor(db), 5);
  assert.deepEqual(out, { c: 7, m: 1234 });
  const q = db.plan.filter((p) => p.op === 'first')[0];
  assert.ok(q.sql.includes('COUNT(*) AS c, MAX(i.published) AS m'));
  assert.deepEqual(q.args, [5, 5]);
});

test('unread: starred combines subscribed + starred + notRead order', async () => {
  const db = new FakeDB({ onFirst: () => null });
  const out = await starredUnread(envFor(db), 4);
  assert.equal(out, 0);
  const q = db.plan.filter((p) => p.op === 'first')[0];
  const sIdx = q.sql.indexOf("s.state='starred'");
  const rIdx = q.sql.indexOf("s.state='read'");
  assert.ok(sIdx < rIdx);
  assert.deepEqual(q.args, [4, 4, 4]);
});
