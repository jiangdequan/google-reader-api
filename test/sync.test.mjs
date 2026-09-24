import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAndStoreFeed, ensureFeed, runSync } from '../sync.js';
import { FakeDB } from './_fakedb.mjs';

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>TestFeed</title>
  <link rel="alternate" href="https://ex.com/"/>
  <updated>2026-09-20T00:00:00Z</updated>
  <entry>
    <title>E1</title>
    <link href="https://ex.com/1"/>
    <id>urn:1</id>
    <updated>2026-09-20T00:00:00Z</updated>
    <content type="html">hi</content>
  </entry>
</feed>`;

// Response forbids a 304 body; fetchFeed only reads `.status` on this path.
const notModified = () => ({ status: 304 });

const silent = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
};

test('fetchAndStoreFeed: fetch throws -> {error}, updateFetchMeta records fetch_error', async (t) => {
  silent(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('boom');
  });
  const db = new FakeDB();
  const res = await fetchAndStoreFeed({ DB: db }, { id: 4, url: 'https://x.com/rss', etag: '', updated: 0 });
  assert.deepEqual(res, { feedId: 4, url: 'https://x.com/rss', error: 'boom' });
  const up = db.runs('UPDATE feeds SET last_fetched');
  assert.equal(up.length, 1);
  assert.equal(up[0].args[1], 'boom'); // fetch_error
  assert.equal(up[0].args[4], 4); // id
});

test('fetchAndStoreFeed: empty url fails without network and still records error', async (t) => {
  silent(t);
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    called++;
    return new Response('', { status: 200 });
  });
  const db = new FakeDB();
  const res = await fetchAndStoreFeed({ DB: db }, { id: 9, url: '', etag: '', updated: 0 });
  assert.equal(res.error, 'bad url');
  assert.equal(called, 0);
  assert.equal(db.runs('UPDATE feeds SET last_fetched').length, 1);
});

test('fetchAndStoreFeed: HTTP 500 -> {error: HTTP 500}, no items written', async (t) => {
  silent(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 500 }));
  const db = new FakeDB();
  const res = await fetchAndStoreFeed({ DB: db }, { id: 2, url: 'https://x.com/rss', etag: '', updated: 0 });
  assert.equal(res.error, 'HTTP 500');
  assert.equal(db.plan.filter((p) => p.sql.includes('INSERT')).length, 0);
});

test('fetchAndStoreFeed: 304 unchanged -> only refreshes last_fetched', async (t) => {
  silent(t);
  t.mock.method(globalThis, 'fetch', notModified);
  const db = new FakeDB();
  const res = await fetchAndStoreFeed({ DB: db }, { id: 7, url: 'https://x.com/rss', etag: 'W/"e"', updated: 1 });
  assert.deepEqual(res, { feedId: 7, url: 'https://x.com/rss', unchanged: true });
  const up = db.runs('UPDATE feeds SET last_fetched');
  assert.equal(up.length, 1);
  // unchanged clears error/etag/updated ({} destructure), keeps only last_fetched
  assert.deepEqual(up[0].args.slice(1), ['', '', 0, 7]);
  assert.equal(db.plan.filter((p) => p.sql.includes('INSERT INTO items')).length, 0);
});

test('fetchAndStoreFeed: new feed -> insertFeed + insertNewItems + prune + updateFetchMeta', async (t) => {
  silent(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(ATOM, {
        status: 200,
        headers: {
          'content-type': 'application/atom+xml',
          etag: 'W/"v1"',
          'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      }),
  );
  const db = new FakeDB({
    onFirst: (s) => (s.sql.includes('WHERE url=?') ? null : null),
    onRun: (s) => (s.sql.includes('INSERT INTO feeds') ? { meta: { last_row_id: 15 } } : { meta: { last_row_id: 1 } }),
  });
  const env = { DB: db, MAX_ITEMS_PER_FEED: '50' };
  const res = await fetchAndStoreFeed(env, { id: 0, url: 'https://x.com/rss', etag: '', updated: 0, title: '' });
  assert.equal(res.feedId, 15);
  assert.equal(res.url, 'https://x.com/rss');
  assert.equal(res.added, 1); // one Atom entry stored

  const ins = db.runs('INSERT INTO feeds');
  assert.equal(ins.length, 1);
  assert.deepEqual(ins[0].args.slice(0, 3), ['https://x.com/rss', 'TestFeed', 'https://ex.com/']);
  assert.equal(ins[0].args[4], 'W/"v1"'); // etag

  const items = db.plan.filter((p) => p.sql.includes('INSERT OR IGNORE INTO items'));
  assert.equal(items.length, 0); // batch() records via batches, not plan runs
  assert.ok(db.batches.some((b) => b.some((s) => s.sql.includes('INSERT OR IGNORE INTO items'))));

  const prune = db.runs('DELETE FROM items WHERE feed_id=?');
  assert.equal(prune.length, 1);
  assert.deepEqual(prune[0].args, [15, 15, 50]);

  const up = db.runs('UPDATE feeds SET last_fetched');
  assert.equal(up.length, 1);
  assert.equal(up[0].args[2], 'W/"v1"'); // etag
  assert.equal(up[0].args[3], Math.floor(Date.parse('Wed, 01 Jan 2025 00:00:00 GMT') / 1000));
  assert.equal(up[0].args[4], 15);
});

test('ensureFeed: unknown url fetches+stores and returns stored row fallback', async (t) => {
  silent(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(ATOM, {
        status: 200,
        headers: { 'content-type': 'application/atom+xml' },
      }),
  );
  const db = new FakeDB({
    onRun: (s) => (s.sql.includes('INSERT INTO feeds') ? { meta: { last_row_id: 15 } } : { meta: { last_row_id: 1 } }),
  });
  const out = await ensureFeed({ DB: db }, 'https://x.com/rss');
  assert.deepEqual(out, { id: 15, url: 'https://x.com/rss' });
});

test('ensureFeed: known url short-circuits without fetching', async (t) => {
  silent(t);
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    called++;
    return new Response('', { status: 500 });
  });
  const existing = { id: 3, url: 'https://x.com/rss', title: 'T' };
  const db = new FakeDB({ onFirst: (s) => (s.sql.includes('WHERE url=?') ? existing : null) });
  const out = await ensureFeed({ DB: db }, 'https://x.com/rss');
  assert.deepEqual(out, existing);
  assert.equal(called, 0);
});

test('runSync: processes stale feeds concurrently, 304 path refreshes meta', async (t) => {
  silent(t);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (u) => {
    seen.push(String(u));
    return notModified();
  });
  const stale = [
    { id: 1, url: 'https://x.com/1', etag: 'e1', updated: 0, title: 'a' },
    { id: 2, url: 'https://x.com/2', etag: '', updated: 0, title: 'b' },
    { id: 3, url: 'https://x.com/3', etag: 'e3', updated: 5, title: 'c' },
  ];
  const db = new FakeDB({
    onAll: (s) => (s.sql.includes('last_fetched <') ? stale : []),
  });
  const done = await runSync({ DB: db });
  assert.equal(done, 3);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((u) => u.startsWith('https://x.com/')));
  const ups = db.runs('UPDATE feeds SET last_fetched');
  assert.equal(ups.length, 3);
  assert.deepEqual(ups.map((u) => u.args[4]).sort(), [1, 2, 3]);
});
