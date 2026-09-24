import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpml, parseOpml } from '../opml.js';
import { importOpml } from '../api/opml.js';
import { FakeDB } from './_fakedb.mjs';

const ATOM =
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>T</title><updated>2026-09-20T00:00:00Z</updated>
` +
  `<entry><title>E</title><id>urn:1</id><updated>2026-09-20T00:00:00Z</updated><link href="https://e.com/1"/></entry>` +
  `</feed>`;

const silent = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
};

test('opml: buildOpml -> parseOpml round-trips labels, escaping and feed:// urls', () => {
  const out = buildOpml('Title & <More>', [
    { name: null, feeds: [{ title: 'a"b&c', xmlUrl: 'https://x.com/a&b', htmlUrl: 'https://x.com/' }] },
    { name: 'Dev <Tag>', feeds: [{ title: 'c', xmlUrl: 'feed://y.com/rss', htmlUrl: '' }] },
    { name: null, feeds: [] }, // empty group skipped
  ]);
  assert.match(out, /<title>Title &amp; &lt;More&gt;<\/title>/);
  const parsed = parseOpml(out);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { title: 'a"b&c', xmlUrl: 'https://x.com/a&b', htmlUrl: 'https://x.com/', group: null });
  assert.deepEqual(parsed[1], { title: 'c', xmlUrl: 'feed://y.com/rss', htmlUrl: '', group: 'Dev <Tag>' });
});

test('opml: empty body produces no feeds', () => {
  assert.deepEqual(parseOpml('not xml at all'), []);
});

test('importOpml: feed:// in raw OPML is normalized to https and subscriptions added', async (t) => {
  silent(t);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (u) => {
    seen.push(String(u));
    return new Response(ATOM, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
  });
  const opml = `<opml version="2.0"><body>
    <outline text="Dev"><outline type="rss" text="A" xmlUrl="feed://x.com/rss"/></outline>
    <outline type="rss" text="B" xmlUrl="https://y.com/feed"/>
  </body></opml>`;
  const db = new FakeDB({
    onRun: (s) => (s.sql.includes('INSERT INTO feeds') ? { meta: { last_row_id: 5 } } : { meta: { last_row_id: 1 } }),
    onFirst: (s) => (s.sql.includes('FROM tags') ? { id: 1 } : null), // ensureTag row
  });
  const res = await importOpml(
    { url: 'https://r/reader/api/0/import-opml', method: 'POST', text: async () => opml },
    { DB: db },
    { id: 1 },
  );
  assert.equal(await res.text(), 'OK added=2');
  assert.deepEqual(seen, ['https://x.com/rss', 'https://y.com/feed']);
  const subs = db.runs('INSERT OR IGNORE INTO subscriptions');
  assert.deepEqual(
    subs.map((s) => s.args),
    [
      [1, 5, ''],
      [1, 5, ''],
    ],
  );
});

test('importOpml: form-encoded file= body and already-subscribed feeds are not re-added', async (t) => {
  silent(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(ATOM, { status: 200, headers: { 'content-type': 'application/atom+xml' } }),
  );
  const opml = `<opml version="2.0"><body><outline type="rss" text="A" xmlUrl="https://k.com/rss"/></body></opml>`;
  const db = new FakeDB({
    onRun: (s) => (s.sql.includes('INSERT INTO feeds') ? { meta: { last_row_id: 5 } } : { meta: { last_row_id: 1 } }),
    onFirst: (s) => (s.sql.includes('FROM subscriptions') ? { one: 1 } : null),
  });
  const res = await importOpml(
    { url: 'https://r/reader/api/0/import-opml', method: 'POST', text: async () => 'file=' + encodeURIComponent(opml) },
    { DB: db },
    { id: 1 },
  );
  assert.equal(await res.text(), 'OK added=0');
  assert.equal(db.runs('INSERT OR IGNORE INTO subscriptions').length, 0);
});
