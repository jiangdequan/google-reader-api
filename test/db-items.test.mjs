import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStreamWhere,
  getItemsStream,
  insertNewItems,
  markStreamRead,
  pruneFeed,
  searchItems,
} from '../db/items.js';
import { BATCH_CHUNK } from '../db/util.js';

const USER = 'user-123';
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// Minimal D1 binding recording every prepare/bind/run plus statement order.
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = null;
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() {
    this.db.plan.push({ op: 'all', sql: this.sql, args: this.args });
    return { results: await this.db.onAll(this) };
  }
  async run() {
    this.db.plan.push({ op: 'run', sql: this.sql, args: this.args });
    return await this.db.onRun(this);
  }
  async first() {
    this.db.plan.push({ op: 'first', sql: this.sql, args: this.args });
    return await this.db.onFirst(this);
  }
}

class FakeDB {
  constructor(opts = {}) {
    this.onAll = opts.onAll || (() => []);
    this.onRun = opts.onRun || (() => undefined);
    this.onFirst = opts.onFirst || (() => null);
    this.plan = [];
    this.batches = [];
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  async batch(stmts) {
    this.batches.push(stmts.map((s) => ({ sql: s.sql, args: s.args })));
    return Promise.all(stmts.map((s) => s.all()));
  }
}

test('buildStreamWhere: state stream materializes reading-list as subscription exists', () => {
  for (const state of ['reading-list', 'unread']) {
    const { where, args } = buildStreamWhere(USER, { kind: 'state', state });
    assert.equal(args.length, 1);
    assert.equal(args[0], USER);
    assert.match(where, /EXISTS \(SELECT 1 FROM subscriptions su WHERE su\.user_id=\? AND su\.feed_id=i\.feed_id\)/);
    assert.doesNotMatch(where, /item_states/);
  }
});

test('buildStreamWhere: concrete state maps to item_states', () => {
  const { where, args } = buildStreamWhere(USER, { kind: 'state', state: 'read' });
  assert.deepEqual(args, [USER, 'read']);
  assert.match(
    where,
    /EXISTS \(SELECT 1 FROM item_states s WHERE s\.user_id=\? AND s\.item_id=i\.id AND s\.state=\?\)/,
  );
});

test('buildStreamWhere: xt state reading-list/unread is a no-op (regression guard)', () => {
  const { where, args } = buildStreamWhere(
    USER,
    { kind: 'state', state: 'read' },
    { xtResolved: [{ kind: 'state', state: 'unread' }] },
  );
  assert.deepEqual(args, [USER, 'read']);
  assert.doesNotMatch(where, /NOT EXISTS/);
  const matches = where.match(/EXISTS \(SELECT 1 FROM item_states/g) || [];
  assert.equal(matches.length, 1);
});

test('buildStreamWhere: xt concrete state negates item_states', () => {
  const { where, args } = buildStreamWhere(
    USER,
    { kind: 'state', state: 'starred' },
    { xtResolved: [{ kind: 'state', state: 'read' }] },
  );
  assert.deepEqual(args, [USER, 'starred', USER, 'read']);
  assert.match(
    where,
    /NOT EXISTS \(SELECT 1 FROM item_states s WHERE s\.user_id=\? AND s\.item_id=i\.id AND s\.state=\?\)/,
  );
});

test('buildStreamWhere: it state reading-list/unread adds no OR-branch (regression guard)', () => {
  const { where, args } = buildStreamWhere(
    USER,
    { kind: 'feed', feedId: 7 },
    { itResolved: [{ kind: 'state', state: 'unread' }] },
  );
  assert.equal(norm(where), 'WHERE i.feed_id = ?');
  assert.deepEqual(args, [7]);
});

test('buildStreamWhere: it starved state uses s2 alias inside OR group', () => {
  const { where, args } = buildStreamWhere(
    USER,
    { kind: 'feed', feedId: 7 },
    { itResolved: [{ kind: 'state', state: 'starred' }] },
  );
  assert.deepEqual(args, [7, USER, 'starred']);
  assert.match(
    where,
    /\(EXISTS \(SELECT 1 FROM item_states s2 WHERE s2\.user_id=\? AND s2\.item_id=i\.id AND s2\.state=\?\)\)/,
  );
});

test('buildStreamWhere: label stream and xt-label exclusion', () => {
  const { where: lw, args: la } = buildStreamWhere(USER, { kind: 'label', name: 'dev' });
  assert.deepEqual(la, [USER, 'dev', USER, 'dev']);
  assert.match(lw, /EXISTS \(SELECT 1 FROM subscription_tags st JOIN tags t ON t\.id=st\.tag_id/);
  assert.match(lw, /EXISTS \(SELECT 1 FROM item_tags il WHERE il\.user_id=\? AND il\.item_id=i\.id AND il\.label=\?\)/);

  const { where: xw } = buildStreamWhere(
    USER,
    { kind: 'state', state: 'reading-list' },
    { xtResolved: [{ kind: 'label', name: 'dev' }] },
  );
  assert.match(xw, /NOT \(EXISTS \(SELECT 1 FROM subscription_tags/);
});

test('buildStreamWhere: time bounds are ANDed in arg order', () => {
  const { where, args } = buildStreamWhere(USER, { kind: 'feed', feedId: 1 }, { ot: 100, nt: 200 });
  assert.deepEqual(args, [1, 100, 200]);
  assert.equal(norm(where), 'WHERE i.feed_id = ? AND i.published >= ? AND i.published <= ?');
});

test('getItemsStream: offset paging emits DESC order, LIMIT+1 + OFFSET binds', async () => {
  const db = new FakeDB({ onAll: () => Array.from({ length: 21 }, (_, k) => ({ rowid: k + 1, id: String(k + 1) })) });
  const r = await getItemsStream({ DB: db }, USER, { kind: 'state', state: 'reading-list' }, { limit: 20, offset: 3 });

  const q = db.plan[0];
  assert.match(q.sql, /SELECT i\.rowid, i\.\*, f\.url AS feed_url/);
  assert.match(q.sql, /ORDER BY i\.published DESC, i\.id DESC LIMIT \? OFFSET \?/);
  assert.deepEqual(q.args, [USER, 21, 3]);
  assert.equal(r.rows.length, 20);
  assert.equal(r.hasMore, true);
});

test('getItemsStream: cursor pins (published,id) pair and supersedes offset', async () => {
  const db = new FakeDB({ onAll: () => Array.from({ length: 5 }, (_, k) => ({ rowid: k + 1, id: String(k + 1) })) });
  await getItemsStream(
    { DB: db },
    USER,
    { kind: 'state', state: 'reading-list' },
    { limit: 10, offset: 99, order: 'o', cursor: { published: 5, id: '42' } },
  );

  const q = db.plan[0];
  assert.match(q.sql, /ORDER BY i\.published ASC, i\.id ASC LIMIT \?/);
  assert.match(q.sql, /AND \(i\.published > \? OR \(i\.published = \? AND i\.id > \?\)\)/);
  assert.doesNotMatch(q.sql, /OFFSET/);
  assert.deepEqual(q.args, [USER, 5, 5, '42', 11]);
});

test('getItemsStream: refsOnly keeps the slim projection', async () => {
  const db = new FakeDB({ onAll: () => [] });
  await getItemsStream({ DB: db }, USER, { kind: 'state', state: 'reading-list' }, { refsOnly: true });

  const q = db.plan[0];
  assert.match(q.sql, /SELECT i\.rowid, i\.id, i\.published, i\.timestamp_usec FROM items i/);
  assert.doesNotMatch(q.sql, /JOIN feeds/);
  assert.deepEqual(q.args, [USER, 21]);
});

test('insertNewItems: inserts new, backfills url for stored empty-url, honors MAX_ITEM_AGE_DAYS', async () => {
  const stored = new Map([['c', '']]); // guid c stored without a url
  const db = new FakeDB({
    onAll: (stmt) => {
      if (stmt.sql.includes('SELECT guid, url FROM items')) {
        const guids = stmt.args.slice(1).map(String);
        return guids.filter((g) => stored.has(g)).map((g) => ({ guid: g, url: stored.get(g) }));
      }
      return [];
    },
  });
  const env = { DB: db, MAX_ITEM_AGE_DAYS: '100' };
  const ts = Math.floor(Date.now() / 1000);
  const added = await insertNewItems(env, 1, 'http://f/', [
    { guid: 'a', title: 'A', published: 0 },
    { guid: 'a', title: 'A dup', published: 0 },
    { guid: 'b', title: 'B', published: 0 },
    { guid: 'c', title: 'C', url: 'http://f/c.html', published: 0 },
    { guid: 'veryOld', title: 'Old', published: ts - 10000000 },
  ]);

  assert.equal(added, 2);
  const inserts = db.plan.filter((p) => p.sql.includes('INSERT OR IGNORE INTO items'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(
    inserts.map((i) => i.args[3]),
    ['', '', 'http://f/c.html'].slice(0, 2),
  ); // rows a,b; c backfilled not inserted

  const updates = db.plan.filter((p) => p.sql.includes('UPDATE items SET url='));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].args, ['http://f/c.html', 1, 'c']);
});

test('insertNewItems: published=0 always kept, chunked into BATCH_CHUNK batches', async () => {
  const db = new FakeDB({ onAll: () => [] });
  const env = { DB: db, MAX_ITEM_AGE_DAYS: '10' };
  const ts = Math.floor(Date.now() / 1000);
  const items = Array.from({ length: 100 }, (_, k) => ({
    guid: 'g' + k,
    title: 't' + k,
    published: k % 2 ? 0 : ts - 1000000,
  }));
  const added = await insertNewItems(env, 1, 'http://f/', items);

  assert.equal(added, 50); // odd indexes (published=0) kept, even (old) dropped
  const insertBatches = db.batches.filter((b) => b.some((s) => s.sql.includes('INSERT OR IGNORE INTO items')));
  assert.equal(insertBatches.length, 1); // 50 rows < BATCH_CHUNK
  assert.equal(insertBatches[0].length, 50);
});

test('insertNewItems: many inserts split into multiple batches with SELECT 1 guard', async () => {
  const db = new FakeDB({ onAll: () => [] });
  const env = { DB: db, MAX_ITEM_AGE_DAYS: '10' };
  const items = Array.from({ length: 130 }, (_, k) => ({ guid: 'g' + k, title: 't' + k, published: 0 }));
  await insertNewItems(env, 1, 'http://f/', items);

  const insertBatches = db.batches.filter((b) => b.some((s) => s.sql.includes('INSERT OR IGNORE INTO items')));
  assert.equal(insertBatches.length, 2);
  assert.equal(insertBatches[0].length, BATCH_CHUNK);
  assert.equal(insertBatches[1].length, 40);
});

test('insertNewItems: empty or all-invalid input short-circuits', async () => {
  const db = new FakeDB({ onAll: () => [] });
  assert.equal(await insertNewItems({ DB: db, MAX_ITEM_AGE_DAYS: '10' }, 1, 'http://f/', []), 0);
  const env = { DB: db, MAX_ITEM_AGE_DAYS: '10' };
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(await insertNewItems(env, 1, 'http://f/', [{ guid: 'x', published: ts - 2000000 }]), 0);
  assert.equal(db.plan.length, 0); // no DB contact for degenerate input
});

test('markStreamRead: read-selection SQL matches buildStreamWhere + time bound', async () => {
  let db;
  db = new FakeDB({ onAll: () => [{ id: '1' }, { id: '2' }] });
  const n = await markStreamRead({ DB: db }, USER, { kind: 'state', state: 'reading-list' }, 1700000000000000);

  const q = db.plan[0];
  assert.equal(
    norm(q.sql),
    'SELECT i.id FROM items i WHERE EXISTS (SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id) AND i.published <= ? ORDER BY i.published DESC LIMIT 10000',
  );
  assert.deepEqual(q.args, [USER, 1700000000]);
  const inserts = db.plan.filter((p) => p.sql.includes('INSERT OR IGNORE INTO item_states'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts[0].args, [USER, '1', 'read']);
  assert.equal(n, 2);
});

test('markStreamRead: no tsUsec keeps only the stream clause', async () => {
  const db = new FakeDB({ onAll: () => [] });
  await markStreamRead({ DB: db }, USER, { kind: 'state', state: 'unread' });
  const q = db.plan[0];
  assert.doesNotMatch(q.sql, /published <=/);
  assert.deepEqual(q.args, [USER]);
});

test('pruneFeed: keeps top-N per feed then sweeps orphans', async () => {
  const db = new FakeDB();
  await pruneFeed({ DB: db }, 9, 50);
  const runs = db.plan.filter((p) => p.op === 'run');
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].args, [9, 9, 50]);
  assert.match(runs[0].sql, /DELETE FROM items WHERE feed_id=\? AND id NOT IN/);
  assert.match(runs[1].sql, /DELETE FROM item_states WHERE item_id NOT IN/);
  assert.match(runs[2].sql, /DELETE FROM item_tags/);
});

test('searchItems: LIKE escapes % _ \ wildcards and binds twice', async () => {
  const db = new FakeDB({ onAll: () => [{ id: '1' }] });
  const r = await searchItems({ DB: db }, USER, '50% off_', {});
  const q = db.plan[0];
  assert.equal(q.args[0], USER);
  assert.equal(q.args[1], '%50\\% off\\_%');
  assert.equal(q.args[2], '%50\\% off\\_%');
  assert.equal(r.length, 1);
});
