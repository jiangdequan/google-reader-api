import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFeed } from '../feedparser.js';

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>My Feed</title>
  <subtitle>sub text</subtitle>
  <link rel="alternate" type="text/html" href="http://example.com/"/>
  <entry>
    <id>tag:example,2000:1</id>
    <title>Post &amp; One</title>
    <link rel="alternate" href="http://example.com/1"/>
    <author><name>Alice</name></author>
    <published>2024-01-02T03:04:05Z</published>
    <updated>2024-01-03T00:00:00Z</updated>
    <content type="html">&lt;b&gt;hi&lt;/b&gt;</content>
    <link rel="enclosure" href="http://example.com/1.mp3"/>
  </entry>
  <entry>
    <id>tag:example,2000:2</id>
    <title>Xhtml</title>
    <content type="xhtml"><div><p>A 'quote' &amp; <b>bold</b></p></div></content>
  </entry>
</feed>`;

const RSS2 = `<rss version="2.0"><channel>
<title>RSS Title</title><link>http://ex.com</link><description>desc</description>
<item><guid>g1</guid><link>http://ex.com/1</link><title>One</title><pubDate>Tue, 02 Jan 2024 03:04:05 GMT</pubDate></item>
<item><link>http://ex.com/2</link><title>Two</title><description><![CDATA[<b>c</b>]]></description></item>
</channel></rss>`;

const RSS1 = `<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<channel><title>RSS1</title><link>http://ex.com</link><description>d</description></channel>
<item rdf:about="http://ex.com/1"><title>I1</title><link>http://ex.com/1</link></item>
</rdf:RDF>`;

const JSONFEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JF',
  home_page_url: 'http://ex.com/',
  description: 'd',
  items: [
    {
      id: 'j1',
      url: 'http://ex.com/j1',
      title: 'J1',
      content_html: '<p>hi</p>',
      date_published: '2024-01-02T03:04:05Z',
      author: { name: 'Bob' },
    },
  ],
});

test('atom: title, htmlUrl, description and two entries', () => {
  const f = parseFeed(ATOM, 'application/atom+xml');
  assert.equal(f.type, 'atom');
  assert.equal(f.title, 'My Feed');
  assert.equal(f.htmlUrl, 'http://example.com/');
  assert.equal(f.description, 'sub text');
  assert.equal(f.items.length, 2);
});

test('atom: entry fields, entities and enclosure', () => {
  const f = parseFeed(ATOM, 'application/atom+xml');
  const [a, b] = f.items;
  assert.equal(a.guid, 'tag:example,2000:1');
  assert.equal(a.url, 'http://example.com/1');
  assert.equal(a.title, 'Post & One');
  assert.equal(a.author, 'Alice');
  assert.deepEqual(a.content, '<b>hi</b>');
  assert.equal(a.enclosure, 'http://example.com/1.mp3');
  assert.equal(a.published, Math.floor(Date.parse('2024-01-02T03:04:05Z') / 1000));
  assert.equal(a.updated, Math.floor(Date.parse('2024-01-03T00:00:00Z') / 1000));

  // xhtml content serializes through the shared escape helpers.
  assert.equal(b.content, `<div><p>A 'quote' &amp; <b>bold</b></p></div>`);
});

test('rss2: guid falls back to link, CDATA content preserved', () => {
  const f = parseFeed(RSS2, 'text/xml');
  assert.equal(f.type, 'rss');
  assert.equal(f.title, 'RSS Title');
  assert.equal(f.items.length, 2);
  const [one, two] = f.items;
  assert.equal(one.guid, 'g1');
  assert.equal(one.url, 'http://ex.com/1');
  assert.equal(one.published, Math.floor(Date.parse('2024-01-02T03:04:05Z') / 1000));
  assert.equal(two.guid, 'http://ex.com/2'); // no <guid> -> link
  assert.equal(two.content, '<b>c</b>');
});

test('rss1: items are direct children of the RDF root', () => {
  const f = parseFeed(RSS1, 'application/rdf+xml');
  assert.equal(f.type, 'rss1');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].guid, 'http://ex.com/1');
});

test('jsonfeed: content_html and structured author', () => {
  const f = parseFeed(JSONFEED, 'application/json');
  assert.equal(f.type, 'json');
  assert.equal(f.title, 'JF');
  assert.equal(f.items.length, 1);
  const it = f.items[0];
  assert.equal(it.guid, 'j1');
  assert.equal(it.content, '<p>hi</p>');
  assert.equal(it.author, 'Bob');
  assert.equal(it.published, Math.floor(Date.parse('2024-01-02T03:04:05Z') / 1000));
});

test('non-feed bodies return null across formats', () => {
  assert.equal(parseFeed('  ', ''), null);
  assert.equal(parseFeed('<html><body>nope</body></html>', 'text/html'), null);
  assert.equal(parseFeed('not { valid json', 'application/json'), null);
});
