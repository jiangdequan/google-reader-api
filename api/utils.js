import { b64urlEncode, b64urlDecode, decodeURIComponentSafe, escapeHtml, xml } from '../util.js';
import { getItemsByIds, resolveStreamId, setItemLabel, setItemState } from '../db/items.js';
import { getFeedById } from '../db/feeds.js';
import { parseStreamId, serializeStreamId } from '../streamid.js';

export { decodeURIComponentSafe };

// A "label" term is either a canonical user/-/(label|tag|tags)/<name> stream id
// or a bare name; state/feed and other user-prefixed ids are not labels at all.
export function stripLabel(term) {
  const s = String(term || '').trim();
  const p = parseStreamId(s);
  if (p.kind === 'label') return p.name;
  if (p.kind === 'state' || p.userPrefixed) return '';
  return decodeURIComponentSafe(s);
}

function tagObject(term) {
  const s = String(term || '').trim();
  if (!s) return { kind: 'none' };
  const p = parseStreamId(s);
  if (p.kind === 'feed') return { kind: 'none' };
  if (p.kind === 'state') return p.state ? { kind: 'state', state: p.state } : { kind: 'none' };
  if (p.kind === 'label') return p.name ? { kind: 'label', name: p.name } : { kind: 'none' };
  if (p.feedPrefixed || p.userPrefixed) return { kind: 'none' };
  return { kind: 'label', name: decodeURIComponentSafe(s) };
}

export const canonicalStreamId = serializeStreamId;

export async function applyTag(env, user, itemId, term, on) {
  const t = tagObject(term);
  const uid = user.id;
  const rows = await getItemsByIds(env, uid, [itemId]);
  const id = rows.length ? rows[0].id : itemId;
  if (t.kind === 'state') {
    const st = t.state;
    if (st === 'read') {
      await setItemState(env, uid, id, 'read', on);
      if (on) await setItemState(env, uid, id, 'kept-unread', false);
    } else if (st === 'unread') {
      await setItemState(env, uid, id, 'read', !on);
    } else if (st === 'kept-unread') {
      if (on) {
        await setItemState(env, uid, id, 'read', false);
        await setItemState(env, uid, id, 'kept-unread', true);
      } else {
        await setItemState(env, uid, id, 'kept-unread', false);
      }
    } else if (st === 'starred') {
      await setItemState(env, uid, id, 'starred', on);
    } else if (st === 'broadcast') {
      await setItemState(env, uid, id, 'broadcast', on);
    }
    // com.google/tracking-* ignored
  } else if (t.kind === 'label') {
    await setItemLabel(env, uid, id, t.name, on);
  }
}

export async function readForm(request) {
  try {
    return new URLSearchParams(await request.text());
  } catch (e) {
    // GET requests carry no body; an empty form is the expected fallback.
    return new URLSearchParams();
  }
}

export function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export async function resolveStreamIds(env, terms) {
  const results = await Promise.all(
    (terms || []).map(async (term) => {
      const s = String(term).trim();
      const target = await resolveStreamId(env, s);
      return target.kind !== 'unknown' ? target : null;
    }),
  );
  return results.filter(Boolean);
}

export function contDec(c) {
  if (!c) return 0;
  try {
    const s = b64urlDecode(String(c));
    const m = s.match(/^v1\|(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch (e) {
    return 0;
  }
}

export function cursorEnc(order, published, id) {
  return b64urlEncode('v2|' + (order === 'o' ? 'o' : 'd') + '|' + published + '|' + id);
}

export function cursorDec(c) {
  if (!c) return null;
  try {
    const s = b64urlDecode(String(c));
    const m = s.match(/^v2\|(o|d)\|(-?\d+)\|(.+)$/);
    return m ? { order: m[1] === 'o' ? 'o' : '', published: parseInt(m[2], 10), id: m[3] } : null;
  } catch (e) {
    return null;
  }
}

export async function streamTitle(env, stream, uid, username) {
  if (stream.kind === 'feed') {
    if (stream.feedId) {
      const f = await getFeedById(env, stream.feedId);
      if (f && f.title) return f.title;
    }
    return stream.url;
  }
  if (stream.kind === 'label') return `${stream.name} streaming list`;
  switch (stream.state) {
    case 'starred':
      return "Starred items";
    case 'broadcast':
      return "Shared items";
    case 'kept-unread':
      return "Kept-unread items";
    case 'read':
      return "Read items";
    case 'fresh':
      return "Fresh items";
    default:
      return `${username}'s reading list`;
  }
}

export function itemToJson(r, uid, states, labels) {
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

export function iconUrl(origin, url) {
  try {
    const host = new URL(url).host;
    return `${origin}/favicon?host=${encodeURIComponent(host)}`;
  } catch (e) {
    return '';
  }
}