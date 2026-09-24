import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchFeed } from '../feedfetch.js';
import { MAX_FETCH_BODY_BYTES } from '../constants.js';

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><id>urn:1</id><title>One</title></entry>
</feed>`;

const env = {};

function feedResponse(body, { status = 200, headers = {}, url } = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/atom+xml', ...headers },
    ...(url ? { url } : {}),
  });
}

test('fetchFeed: parses XML and reports finalUrl/title/items', async (t) => {
  t.mock.method(globalThis, 'fetch', () => feedResponse(ATOM, { headers: { etag: 'e1' }, url: 'https://f.com/rss' }));
  const out = await fetchFeed({ ...env }, { id: 0, url: 'https://f.com/rss', etag: '', updated: 0, title: '' });
  assert.equal(out.error, undefined);
  assert.equal(out.feed.finalUrl, 'https://f.com/rss');
  assert.equal(out.feed.title, 'A');
  assert.equal(out.feed.etag, 'e1');
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].guid, 'urn:1');
});

test('fetchFeed: 304 short-circuits to unchanged without parsing', async (t) => {
  t.mock.method(globalThis, 'fetch', () => ({ status: 304 }));
  const out = await fetchFeed(env, { id: 1, url: 'https://f.com/rss', etag: 'e1', updated: 100, title: '' });
  assert.deepEqual(out, { unchanged: true });
});

test('fetchFeed: HTTP errors map to error strings', async (t) => {
  t.mock.method(globalThis, 'fetch', () => new Response('nope', { status: 500 }));
  const out = await fetchFeed({ ...env }, { id: 0, url: 'https://f.com/rss', etag: '', updated: 0, title: '' });
  assert.equal(out.error, 'HTTP 500');
});

test('fetchFeed: normalizeUrl rejects empty and feeds back the request feedId/url', async (t) => {
  const out = await fetchFeed(env, { id: 2, url: '', etag: '', updated: 0, title: '' });
  assert.deepEqual(out, { error: 'bad url' });
});

test('fetchFeed: normalizes feed:// and bare host to https', async (t) => {
  t.mock.method(globalThis, 'fetch', (u, opts) => {
    assert.equal(u, 'https://f.com/rss');
    return feedResponse(ATOM);
  });
  await fetchFeed({ ...env }, { id: 0, url: 'feed://f.com/rss', etag: '', updated: 0, title: '' });
  assert.equal(globalThis.fetch.mock.calls[0].arguments[0], 'https://f.com/rss');
});

test('fetchFeed: HTML page with a feed <link> is discovered and re-fetched', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (u) => {
    calls++;
    if (calls === 1) {
      return feedResponse(
        '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
        { headers: { 'content-type': 'text/html' }, url: 'https://blog.example.com/' },
      );
    }
    assert.equal(u, 'https://blog.example.com/feed.xml');
    return feedResponse(ATOM);
  });
  const out = await fetchFeed({ ...env }, { id: 0, url: 'https://blog.example.com/', etag: '', updated: 0, title: '' });
  assert.equal(calls, 2);
  assert.equal(out.feed.finalUrl, 'https://blog.example.com/feed.xml');
  assert.equal(out.items.length, 1);
});

test('fetchFeed: oversized bodies are truncated to MAX_FETCH_BODY_BYTES', async (t) => {
  // entry2 sits entirely past the 3MB cap (after ~3MB of padding), so a
  // properly truncated body can no longer contain it — parsed items must be 1.
  const pad = 'x'.repeat(MAX_FETCH_BODY_BYTES);
  const big = ATOM.replace(
    '</feed>',
    '<content>' + pad + '</content><entry><id>urn:2</id><title>Two</title></entry></feed>',
  );
  assert.ok(big.length > MAX_FETCH_BODY_BYTES);
  t.mock.method(globalThis, 'fetch', () => feedResponse(big));
  const out = await fetchFeed(env, { id: 0, url: 'https://f.com/rss', etag: '', updated: 0, title: '' });
  assert.equal(out.error, undefined);
  assert.equal(out.items.length, 1, 'entries beyond the cap were dropped');
  assert.equal(out.items[0].guid, 'urn:1');
});

test('fetchFeed: non-feed non-HTML body yields not a feed', async (t) => {
  t.mock.method(globalThis, 'fetch', () => feedResponse('<html><body>nope</body></html>'));
  const out = await fetchFeed({ ...env }, { id: 0, url: 'https://f.com/rss', etag: '', updated: 0, title: '' });
  assert.equal(out.error, 'not a feed');
});
