import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getFeedByUrl, insertFeed, staleFeeds, updateFetchMeta } from '../db/feeds.js';
import { FakeDB } from './_fakedb.mjs';

test('insertFeed: UPDATEs when the url already exists, keeping stored fields as fallback', async () => {
  const existing = { id: 7, url: 'https://f.com/rss', title: 'Old', html_url: 'https://f.com', updated: 11 };
  const db = new FakeDB({
    onFirst: (s) => (s.sql.includes('FROM feeds WHERE url') ? existing : null),
  });
  const out = await insertFeed({ DB: db }, { url: 'https://f.com/rss', title: '', updated: 0 });
  assert.equal(out.created, false);
  assert.equal(out.id, 7);

  const upd = db.plan.find((p) => p.op === 'run' && p.sql.includes('UPDATE feeds SET'));
  assert.equal(upd.sql, 'UPDATE feeds SET title=?, html_url=?, description=?, etag=?, updated=? WHERE id=?');
  // empty new values fall back to the stored ones, id targets the found row
  assert.deepEqual(upd.args, ['Old', 'https://f.com', '', '', 11, 7]);
});

test('insertFeed: INSERTs a brand-new url and reports last_row_id', async () => {
  const db = new FakeDB({
    onFirst: () => null,
    onRun: (s) => (s.sql.includes('INSERT INTO feeds') ? { meta: { last_row_id: 3 } } : { meta: { last_row_id: 1 } }),
  });
  const out = await insertFeed({ DB: db }, { url: 'https://new.com/rss', title: 'N' });
  assert.equal(out.created, true);
  assert.equal(out.id, 3);

  const ins = db.plan.find((p) => p.op === 'run' && p.sql.includes('INSERT INTO feeds'));
  assert.equal(ins.sql, 'INSERT INTO feeds(url,title,html_url,description,etag,updated) VALUES (?,?,?,?,?,?)');
  assert.deepEqual(ins.args, ['https://new.com/rss', 'N', '', '', '', 0]);
});

test('updateFetchMeta: refreshes last_fetched plus given fields', async () => {
  const db = new FakeDB();
  await updateFetchMeta({ DB: db }, 7, { error: '', etag: 'a11', updated: 5 });
  const up = db.plan.find((p) => p.op === 'run');
  assert.equal(up.sql, 'UPDATE feeds SET last_fetched=?, fetch_error=?, etag=?, updated=? WHERE id=?');
  assert.equal(up.args[0], Math.floor(Date.now() / 1000));
  assert.deepEqual(up.args.slice(1), ['', 'a11', 5, 7]);
});

test('staleFeeds: oldest first, limit bound as a value', async () => {
  const db = new FakeDB({ onAll: () => [{ id: 1 }, { id: 2 }] });
  const rows = await staleFeeds({ DB: db }, 1000, 2);
  assert.equal(rows.length, 2);
  const q = db.plan.find((p) => p.op === 'all');
  assert.equal(q.sql, 'SELECT * FROM feeds WHERE last_fetched < ? ORDER BY last_fetched ASC LIMIT ?');
  assert.deepEqual(q.args, [1000, 2]);
});

test('getFeedByUrl: selects by exact url', async () => {
  const db = new FakeDB({ onFirst: () => ({ id: 1 }) });
  await getFeedByUrl({ DB: db }, 'https://x/rss');
  const q = db.plan[0];
  assert.equal(q.sql, 'SELECT * FROM feeds WHERE url=?');
  assert.deepEqual(q.args, ['https://x/rss']);
});
