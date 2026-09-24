import { escapeHtml, xml } from '../util.js';

// Maps a stored item row + lookup maps into a Google Reader JSON item.
export function itemToJson(r, states, labels) {
  const stateSet = states[r.id] || new Set();
  const cats = ['user/-/state/com.google/reading-list'];
  if (stateSet.has('read')) cats.push('user/-/state/com.google/read');
  if (stateSet.has('starred')) cats.push('user/-/state/com.google/starred');
  if (stateSet.has('broadcast')) cats.push('user/-/state/com.google/broadcast');
  if (stateSet.has('kept-unread')) cats.push('user/-/state/com.google/kept-unread');
  for (const l of labels[r.id] || []) cats.push('user/-/label/' + l);
  const href = r.url || '';
  const hexId = (Number(r.rowid ?? 0) || 0).toString(16).padStart(16, '0');
  const item = {
    id: 'tag:google.com,2005:reader/item/' + hexId,
    title: r.title,
    published: r.published,
    crawlTimeMsec: (r.crawl_time || Date.now()).toString(),
    timestampUsec: r.timestamp_usec,
    alternate: href ? [{ href }] : [],
    canonical: [{ href }],
    summary: { content: r.content || '' },
    categories: cats,
    origin: {
      streamId: 'feed/' + r.feed_url,
      title: r.feed_title || '',
      htmlUrl: r.feed_html || '',
    },
  };
  if (r.enclosure) item.enclosure = [{ href: r.enclosure, type: '' }];
  if (r.author) item.author = r.author;
  return item;
}

// Renders a stream "out" object (id/title/continuation/items) as Reader Atom.
export function atomContents(out, selfHref) {
  const iso = (ts) => new Date((ts || Date.now() / 1000) * 1000).toISOString();
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  s += `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:gr="http://www.google.com/schemas/reader/atom/">\n`;
  s += `<id>${escapeHtml(out.id)}</id>\n`;
  s += `<title>${escapeHtml(out.title)}</title>\n`;
  s += `<link rel="self" href="${escapeHtml(selfHref)}"/>\n`;
  s += `<updated>${iso()}</updated>\n`;
  s += `<gr:direction>ltr</gr:direction>\n`;
  if (out.continuation) s += `<gr:continuation>${escapeHtml(out.continuation)}</gr:continuation>\n`;
  for (const it of out.items) {
    s += `<entry>\n`;
    s += `<id>${escapeHtml(it.id)}</id>\n`;
    s += `<title>${escapeHtml(it.title)}</title>\n`;
    const href = it.alternate && it.alternate[0] ? it.alternate[0].href : '';
    s += `<link rel="alternate" href="${escapeHtml(href)}"/>\n`;
    s += `<published>${iso(it.published)}</published>\n`;
    s += `<updated>${iso(it.updated || it.published)}</updated>\n`;
    s += `<gr:timestamp>${escapeHtml(it.timestampUsec)}</gr:timestamp>\n`;
    if (it.author) s += `<author><name>${escapeHtml(it.author)}</name></author>\n`;
    for (const c of it.categories || []) s += `<category term="${escapeHtml(c)}"/>\n`;
    const body = (it.summary && it.summary.content) || (it.content && it.content.content) || '';
    s += `<content type="html">${escapeHtml(body)}</content>\n`;
    s += `<gr:origin streamId="${escapeHtml(it.origin.streamId)}" title="${escapeHtml(it.origin.title || '')}" htmlUrl="${escapeHtml(it.origin.htmlUrl || '')}"/>\n`;
    s += `</entry>\n`;
  }
  s += `</feed>\n`;
  return xml(s);
}
