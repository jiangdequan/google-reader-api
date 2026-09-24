import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStreamOpts } from '../api/http.js';
import {
  searchItemsIds,
  streamContents,
  streamItemsContents,
  streamItemsCount,
  streamItemsIds,
} from '../api/streams.js';
import { FakeDB, itemRow } from './_fakedb.mjs';

const USER = { id: 7, username: 'alice' };
const envFor = (db) => ({ DB: db });
const req = (url, init = {}) => ({
  url,
  method: init.method || 'GET',
  ...(init.body ? { text: async () => init.body } : {}),
});

test('buildStreamOpts: defaults, n clamp, offset/cursor from c, time bounds, refsOnly', async () => {
  const db = new FakeDB();
  const env = envFor(db);
  const base = 'https://r/stream/contents/user/-/state/com.google/reading-list';

  let u = new URL(base + '?n=30');
  let o = await buildStreamOpts(u, env);
  assert.equal(o.limit, 30);
  assert.equal(o.order, '');
  assert.equal(o.offset, 0);
  assert.equal(o.cursor, null);
  assert.equal(o.ot, null);
  assert.equal(o.nt, null);
  assert.equal('refsOnly' in o, false);

  u = new URL(base + '?n=abc');
  o = await buildStreamOpts(u, env);
  assert.equal(o.limit, 20); // non-numeric n falls back

  u = new URL(base + '?n=5000');
  o = await buildStreamOpts(u, env);
  assert.equal(o.limit, 1000); // contents cap

  u = new URL('https://r/stream/items/ids?s=x&n=5000');
  o = await buildStreamOpts(u, env, { maxLimit: 5000 });
  assert.equal(o.limit, 5000); // ids cap

  u = new URL(base + '?r=o&ot=100&nt=200&c=' + Buffer.from('v1|12').toString('base64url'));
  o = await buildStreamOpts(u, env);
  assert.equal(o.order, 'o');
  assert.equal(o.offset, 12);
  assert.equal(o.cursor, null);
  assert.equal(o.ot, 100);
  assert.equal(o.nt, 200);

  u = new URL(base + '?c=' + Buffer.from('v2|d|100|abc').toString('base64url'));
  o = await buildStreamOpts(u, env);
  assert.deepEqual(o.cursor, { order: '', published: 100, id: 'abc' });
  assert.equal(o.offset, 0);

  o = await buildStreamOpts(u, env, { refsOnly: true });
  assert.equal(o.refsOnly, true);
  o = await buildStreamOpts(u, env, { refsOnly: false });
  assert.equal('refsOnly' in o, false);
});

test('buildStreamOpts: paging:false keeps only xt/it; xt/it resolve & drop unknowns', async () => {
  const db = new FakeDB();
  const env = envFor(db);
  const u = new URL('https://r/stream/items/count?s=feed/9&xt=user/-/label/x&xt=nonsense&it=feed/3&ot=1&n=50');
  const o = await buildStreamOpts(u, env, { paging: false });
  assert.deepEqual(Object.keys(o).sort(), ['itResolved', 'xtResolved']);
  assert.equal('ot' in o, false);
  assert.equal('limit' in o, false);
  // 'nonsense' is unknown -> dropped; x kept as label; feed/3 kept as feed
  assert.deepEqual(o.xtResolved, [{ kind: 'label', name: 'x' }]);
  assert.deepEqual(o.itResolved, [{ kind: 'feed', url: '', feedId: 3 }]);
});

test('streamContents: stream id comes from the /contents/ path', async () => {
  const db = new FakeDB();
  const out = JSON.parse(
    await (
      await streamContents(
        req('https://r/reader/api/0/stream/contents/user/-/state/com.google/reading-list'),
        envFor(db),
        USER,
      )
    ).text(),
  );
  assert.equal(out.id, 'user/-/state/com.google/reading-list');
  assert.equal(out.title, "alice's reading list");
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.self, [
    { href: 'https://r/reader/api/0/stream/contents/user/-/state/com.google/reading-list', id: out.id },
  ]);
});

test('streamContents: feed/https path token is canonicalized to feed/<url>', async () => {
  const db = new FakeDB();
  const out = JSON.parse(
    await (
      await streamContents(req('https://r/reader/api/0/stream/contents/feed/https%3A%2F%2Fa.com%2Ff'), envFor(db), USER)
    ).text(),
  );
  assert.equal(out.id, 'feed/https://a.com/f');
  assert.equal(out.title, 'https://a.com/f');
});

test('streamContents: explicit s= param overrides the path token', async () => {
  const db = new FakeDB();
  const out = JSON.parse(
    await (
      await streamContents(
        req('https://r/reader/api/0/stream/contents/user/-/label/dev?s=user/-/label/override'),
        envFor(db),
        USER,
      )
    ).text(),
  );
  assert.equal(out.id, 'user/-/label/override');
  assert.equal(out.title, 'override streaming list');
});

test('streamContents: bare /stream/contents defaults to the reading list', async () => {
  const db = new FakeDB();
  const out = JSON.parse(await (await streamContents(req('https://r/stream/contents'), envFor(db), USER)).text());
  assert.equal(out.id, 'user/-/state/com.google/reading-list');
});

test('streamContents: /reader/atom/ forces Atom output, keeps s= override', async () => {
  const db = new FakeDB();
  const body = await (
    await streamContents(
      req('https://r/reader/atom/user/-/state/com.google/reading-list?s=user/-/label/dev'),
      envFor(db),
      USER,
    )
  ).text();
  assert.ok(body.startsWith('<?xml'));
  assert.match(body, /user\/-\/label\/dev/);
  assert.match(body, /<feed /);
});

test('streamContents: pages + emits continuation from the last row', async () => {
  const rows = Array.from({ length: 21 }, (_, k) => itemRow(k + 1));
  const db = new FakeDB({ onAll: (s) => (s.sql.includes('AS feed_url') ? rows : []) });
  const out = JSON.parse(
    await (
      await streamContents(
        req('https://r/stream/contents/user/-/state/com.google/reading-list?n=20&r=d'),
        envFor(db),
        USER,
      )
    ).text(),
  );
  assert.equal(out.items.length, 20);
  const last = rows[19];
  const expected = Buffer.from(`v2|d|${last.published}|${last.id}`).toString('base64url');
  assert.equal(out.continuation, expected);
  assert.match(out.items[0].id, /^tag:google\.com,2005:reader\/item\//);
  assert.deepEqual(out.items[0].categories, ['user/-/state/com.google/reading-list']);
});

test('streamItemsIds: empty s returns empty refs', async () => {
  const db = new FakeDB();
  const out = JSON.parse(await (await streamItemsIds(req('https://r/stream/items/ids?n=5'), envFor(db), USER)).text());
  assert.deepEqual(out, { itemRefs: [] });
});

test('streamItemsIds: slim projection refs + continuation (no direct stream ids)', async () => {
  const rows = Array.from({ length: 11 }, (_, k) => itemRow(k + 1));
  const db = new FakeDB({ onAll: (s) => (s.sql.includes('timestamp_usec') ? rows : []) });
  const out = JSON.parse(
    await (
      await streamItemsIds(
        req('https://r/stream/items/ids?s=user/-/state/com.google/reading-list&n=10'),
        envFor(db),
        USER,
      )
    ).text(),
  );
  assert.equal(out.itemRefs.length, 10);
  assert.equal(out.itemRefs[0].id, '1');
  assert.equal('directStreamIds' in out.itemRefs[0], false);
  const last = rows[9];
  const expected = Buffer.from(`v2|d|${last.published}|${last.id}`).toString('base64url');
  assert.equal(out.continuation, expected);
});

test('streamItemsIds: includeAllDirectStreamIds adds state-backed streams', async () => {
  const rows = Array.from({ length: 3 }, (_, k) => itemRow(k + 1));
  const db = new FakeDB({
    onAll: (s) => {
      if (s.sql.includes('AS feed_url')) return rows;
      if (s.sql.includes('FROM item_states')) return [{ item_id: rows[0].id, state: 'read' }];
      return [];
    },
  });
  const out = JSON.parse(
    await (
      await streamItemsIds(
        req('https://r/stream/items/ids?s=user/-/state/com.google/reading-list&includeAllDirectStreamIds=true'),
        envFor(db),
        USER,
      )
    ).text(),
  );
  const ref = out.itemRefs[0];
  assert.deepEqual(ref.directStreamIds, [
    'user/-/state/com.google/reading-list',
    'feed/https://f.com/rss',
    'user/-/state/com.google/read',
  ]);
  assert.deepEqual(ref.originalStreamIds, []);
  assert.deepEqual(out.itemRefs[1].directStreamIds, ['user/-/state/com.google/reading-list', 'feed/https://f.com/rss']);
});

test('streamItemsContents: query i= ids + form body fallback', async () => {
  const rows = [itemRow(1), itemRow(2)];
  let db = new FakeDB({
    onAll: (s) => (s.sql.includes('AS feed_url') ? rows : []),
  });
  let out = JSON.parse(
    await (await streamItemsContents(req('https://r/stream/items/contents?i=1&i=2'), envFor(db), USER)).text(),
  );
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].id, 'tag:google.com,2005:reader/item/0000000000000001');

  db = new FakeDB({ onAll: (s) => (s.sql.includes('AS feed_url') ? rows : []) });
  out = JSON.parse(
    await (
      await streamItemsContents(
        req('https://r/stream/items/contents', { method: 'POST', body: 'i=1&i=2' }),
        envFor(db),
        USER,
      )
    ).text(),
  );
  assert.equal(out.items.length, 2);

  db = new FakeDB();
  out = JSON.parse(await (await streamItemsContents(req('https://r/stream/items/contents'), envFor(db), USER)).text());
  assert.deepEqual(out, { items: [] });
});

test('streamItemsCount: plain count, a=true appends date, empty/unknown guard', async () => {
  let db = new FakeDB({ onFirst: (s) => (s.sql.includes('COUNT') ? { c: 12 } : null) });
  let r = await streamItemsCount(req('https://r/stream/items/count?s=feed/9'), envFor(db), USER);
  assert.equal(await r.text(), '12');

  db = new FakeDB({ onFirst: (s) => (s.sql.includes('MAX(i.published)') ? { m: 1700000000 } : { c: 12 }) });
  r = await streamItemsCount(req('https://r/stream/items/count?s=feed/9&a=true'), envFor(db), USER);
  assert.match(await r.text(), /^12#\w/);

  db = new FakeDB();
  r = await streamItemsCount(req('https://r/stream/items/count'), envFor(db), USER);
  assert.equal(await r.text(), '0');

  r = await streamItemsCount(req('https://r/stream/items/count?s=user/-/nope/thing'), envFor(db), USER);
  assert.equal(await r.text(), '0');
});

test('searchItemsIds: renders 16-hex reader tag ids', async () => {
  const db = new FakeDB({ onAll: (s) => (s.sql.includes('LIKE ? ESCAPE') ? [{ rowid: 1, published: 100 }] : []) });
  const out = JSON.parse(
    await (await searchItemsIds(req('https://r/search/items/ids?q=hello'), envFor(db), USER)).text(),
  );
  assert.equal(out.results[0].id, 'tag:google.com,2005:reader/item/0000000000000001');
  assert.equal(out.results[0].timestampUsec, '100000000');

  const empty = new FakeDB();
  const out2 = JSON.parse(await (await searchItemsIds(req('https://r/search/items/ids'), envFor(empty), USER)).text());
  assert.deepEqual(out2, { results: [] });
});
