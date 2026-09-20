import {
  addSubscription,
  countStreamItems,
  disableTag as dbDisableTag,
  detachLabel,
  getFeedByUrl,
  getFeedById,
  getItemsByIds,
  getItemsStream,
  getLabelsForItems,
  getStatesForItems,
  getSubscriptions,
  hasSubscription,
  labelUnread,
  latestStreamItem,
  latestTimestamps,
  listTags,
  markStreamRead,
  readingListUnread,
  removeSubscription,
  renameTag as dbRenameTag,
  resolveStreamId,
  searchItems as searchItemsDb,
  setItemLabel,
  setItemState,
  starredUnread,
  updateSubscriptionTitle,
  feedUnread,
} from './db.js';
import { issueToken } from './auth.js';
import { json, text, xml, escapeHtml, now, b64urlEncode, b64urlDecode } from './util.js';
import { buildOpml, parseOpml } from './opml.js';
import { fetchAndStoreFeed } from './sync.js';

function stripLabel(term) {
  let s = String(term || '').trim();
  const m = s.match(/^user\/-\/(label|tag|tags)\/(.+)$/);
  if (m) return decodeURIComponentSafe(m[2]);
  if (s.startsWith('user/')) {
    const m2 = s.replace(/^user\/[^/]+\//, 'user/-/').match(/^user\/-\/(label|tag|tags)\/(.+)$/);
    if (m2) return decodeURIComponentSafe(m2[2]);
    return '';
  }
  return decodeURIComponentSafe(s);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function tagObject(term) {
  let s = String(term || '').trim();
  if (s.startsWith('user/')) {
    s = s.replace(/^user\/[^/]+\//, 'user/-/');
    const state = s.match(/^user\/-\/state\/com\.google\/(.+)$/);
    if (state) return { kind: 'state', state: state[1] };
    const label = s.match(/^user\/-\/(label|tag|tags)\/(.+)$/);
    if (label) return { kind: 'label', name: decodeURIComponentSafe(label[2]) };
    return { kind: 'none' };
  }
  if (s.startsWith('feed/')) return { kind: 'none' };
  if (!s) return { kind: 'none' };
  return { kind: 'label', name: decodeURIComponentSafe(s) };
}

async function applyTag(env, user, itemId, term, on) {
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

async function readForm(request) {
  try {
    return new URLSearchParams(await request.text());
  } catch (e) {
    return new URLSearchParams();
  }
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function resolveStreamIds(env, terms) {
  const out = [];
  for (const term of terms || []) {
    const s = String(term).trim();
    const target = await resolveStreamId(env, s);
    if (target.kind !== 'unknown') out.push(target);
  }
  return out;
}

function contDec(c) {
  if (!c) return 0;
  try {
    const s = b64urlDecode(String(c));
    const m = s.match(/^v1\|(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch (e) {
    return 0;
  }
}

function cursorEnc(order, published, id) {
  return b64urlEncode('v2|' + (order === 'o' ? 'o' : 'd') + '|' + published + '|' + id);
}

function cursorDec(c) {
  if (!c) return null;
  try {
    const s = b64urlDecode(String(c));
    const m = s.match(/^v2\|(o|d)\|(-?\d+)\|(.+)$/);
    return m ? { order: m[1] === 'o' ? 'o' : '', published: parseInt(m[2], 10), id: m[3] } : null;
  } catch (e) {
    return null;
  }
}

function canonicalStreamId(stream, uid) {
  if (stream.kind === 'feed') return 'feed/' + stream.url;
  if (stream.kind === 'label') return `user/${uid}/label/${stream.name}`;
  return `user/${uid}/state/com.google/${stream.state}`;
}

async function streamTitle(env, stream, uid, username) {
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

function itemToJson(r, uid, states, labels) {
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
    origin: {
      streamId: 'feed/' + r.feed_url,
      title: r.feed_title || '',
      htmlUrl: r.feed_html || '',
    },
    updated: r.published,
    id: 'tag:google.com,2005:reader/item/' + hexId,
    guid: 'tag:google.com,2005:reader/item/' + hexId,
    categories: cats,
    title: r.title,
    published: r.published,
    timestampUsec: r.timestamp_usec,
    crawlTimeMsec: String(r.crawl_time || Date.now()),
    shortId: `${r.rowid ?? ''}`,
    author: r.author || '',
    canonical: [{ href }],
    alternate: href ? [{ href, type: 'text/html' }] : [],
    content: { direction: 'ltr', content: r.content || '' },
    summary: { content: r.content || '' },
  };
  if (r.enclosure) {
    item.enclosure = { href: r.enclosure, type: '' };
    item.enclosures = [{ href: r.enclosure, type: '' }];
  }
  return item;
}

function atomContents(out, selfHref) {
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
    s += `<content type="html">${escapeHtml(it.content.content || '')}</content>\n`;
    s += `<gr:origin streamId="${escapeHtml(it.origin.streamId)}" title="${escapeHtml(it.origin.title || '')}" htmlUrl="${escapeHtml(it.origin.htmlUrl || '')}"/>\n`;
    s += `</entry>\n`;
  }
  s += `</feed>\n`;
  return xml(s);
}

function iconUrl(origin, url) {
  try {
    const host = new URL(url).host;
    return `${origin}/favicon?host=${encodeURIComponent(host)}`;
  } catch (e) {
    return '';
  }
}

export async function info(env, request) {
  const out = {
    service: 'Self-hosted Google Reader API (Cloudflare Worker)',
    endpoints: [
      '/accounts/ClientLogin',
      '/reader/api/0/auth-token',
      '/reader/api/0/user-info',
      '/reader/api/0/subscription/list',
      '/reader/api/0/subscription/quickadd',
      '/reader/api/0/subscription/edit',
      '/reader/api/0/tag/list',
      '/reader/api/0/edit-tag',
      '/reader/api/0/mark-all-as-read',
      '/reader/api/0/unread-count',
      '/reader/api/0/stream/contents/{stream}',
      '/reader/api/0/stream/items/ids',
      '/reader/api/0/stream/items/contents',
      '/reader/api/0/stream/items/count',
      '/reader/api/0/rename-tag',
      '/reader/api/0/disable-tag',
      '/reader/api/0/preference/list',
      '/reader/api/0/friend/list',
      '/reader/api/0/search/items/ids',
      '/reader/subscriptions/export',
      '/reader/subscriptions/import',
    ],
    auth: 'HTTP Basic (username:password), GoogleLogin auth=<token>, or ?auth=<token> / ?T=<token>',
  };
  return json(out);
}

export async function authToken(request, env, user) {
  return text(await issueToken(env, user.id));
}

export async function userInfo(request, env, user) {
  return json({
    userId: String(user.id),
    userName: user.username,
    userProfileId: String(user.id),
    userEmail: user.username,
    isBloggerUser: false,
    signupTimeSec: String(user.created_at || 0),
    isMultiLoginEnabled: true,
  });
}

export async function unreadCount(request, env, user) {
  const url = new URL(request.url);
  const origin = url.origin;
  const out = { max: 1000, unreadcounts: [] };

  const feedRows = await feedUnread(env, user.id);
  const urlById = {};
  const feedIds = [...new Set(feedRows.map((r) => r.feed_id))];
  for (let i = 0; i < feedIds.length; i += 90) {
    const chunk = feedIds.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    const feeds = await env.DB.prepare(
      `SELECT id, url FROM feeds WHERE id IN (${ph})`,
    )
      .bind(...chunk)
      .all();
    for (const f of feeds.results || []) urlById[f.id] = f.url;
  }
  for (const r of feedRows) {
    if (!r.c) continue;
    out.unreadcounts.push({
      id: 'feed/' + (urlById[r.feed_id] || r.feed_id),
      count: r.c,
      newestItemTimestampUsec: String((r.m || 0) * 1000000),
      updated: r.m,
      twitter: r.m,
      freshness: 1,
    });
  }

  for (const r of await labelUnread(env, user.id)) {
    if (!r.c) continue;
    out.unreadcounts.push({
      id: `user/${user.id}/label/${r.name}`,
      count: r.c,
      newestItemTimestampUsec: String((r.m || 0) * 1000000),
      updated: r.m,
      twitter: r.m,
      freshness: 1,
    });
  }

  const rl = await readingListUnread(env, user.id);
  out.unreadcounts.unshift({
    id: `user/${user.id}/state/com.google/reading-list`,
    count: rl ? rl.c : 0,
    newestItemTimestampUsec: String((rl && rl.m ? rl.m : 0) * 1000000),
    updated: rl ? rl.m : 0,
    freshness: 1,
  });

  const starred = await starredUnread(env, user.id);
  if (starred > 0) {
    out.unreadcounts.push({
      id: `user/${user.id}/state/com.google/starred`,
      count: starred,
      newestItemTimestampUsec: '0',
      freshness: 1,
    });
  }
  return json(out);
}

export async function subscriptionList(request, env, user) {
  const url = new URL(request.url);
  const origin = url.origin;
  const subs = await getSubscriptions(env, user.id);
  const latest = await latestTimestamps(
    env,
    subs.map((s) => s.feed_id),
  );
  const sorted = subs.slice().sort((a, b) =>
    (a.custom_title || a.feed_title || a.feed_url).localeCompare(
      b.custom_title || b.feed_title || b.feed_url,
    ),
  );
  return json({
    subscriptions: sorted.map((s, i) => {
      const title = s.custom_title || s.feed_title || s.feed_url;
      return {
        id: 'feed/' + s.feed_url,
        title,
        categories: (s.labels || []).map((l) => ({
          id: `user/${user.id}/label/${l}`,
          label: l,
        })),
        sortid: 'A' + String(i).padStart(7, '0'),
        firstitemmsec: String(latest[s.feed_id] || 0),
        htmlUrl: s.feed_html || s.feed_url || '',
        iconUrl: iconUrl(origin, s.feed_url),
        url: s.feed_url,
        origin: {
          streamId: 'feed/' + s.feed_url,
          title,
          htmlUrl: s.feed_html || s.feed_url || '',
          url: s.feed_url,
        },
      };
    }),
  });
}

export async function subscriptionQuickadd(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  let q = form.get('quickadd') || url.searchParams.get('quickadd') || '';
  if (q.startsWith('feed/http')) q = q.slice(5);
  if (!q) return json({ numResults: 0, query: q, streamId: '' });
  try {
    q = new URL(q).href;
  } catch (e) {
    return json({ numResults: 0, query: q, streamId: '' });
  }
  const existing = await getFeedByUrl(env, q);
  let feed;
  if (existing) {
    feed = existing;
  } else {
    const res = await fetchAndStoreFeed(env, { url: q, id: 0, etag: '', updated: 0, title: '' });
    if (res.error || !res.feedId) return json({ numResults: 0, query: q, streamId: '' });
    feed = await getFeedByUrl(env, res.url) || { id: res.feedId, url: res.url || q };
  }
  if (!feed || !feed.id) return json({ numResults: 0, query: q, streamId: '' });
  if (!(await hasSubscription(env, user.id, feed.id))) {
    await addSubscription(env, user.id, feed.id, '', []);
  }
  return json({
    numResults: 1,
    query: feed.url || q,
    streamId: 'feed/' + (feed.url || q),
    feedId: '',
    interrupted: false,
  });
}

export async function subscriptionEdit(request, env, user) {
  const form = await readForm(request);
  const ac = form.get('ac') || 'subscribe';
  let s = form.get('s') || form.get('url') || '';
  if (s.startsWith('feed/http')) s = s.slice(5);
  const t = form.get('t') || '';
  const labelsToAdd = form.getAll('add').map(stripLabel).filter(Boolean);
  const labelsToRemove = form.getAll('r').map(stripLabel).filter(Boolean);

  if (ac === 'unsubscribe' || ac === 'remove' || ac === 'unsub' || ac === 'delete') {
    const feed = await getFeedByUrl(env, s);
    if (feed) await removeSubscription(env, user.id, feed.id);
    return text('OK');
  }
  if (!s) return text('OK');

  let feed = await getFeedByUrl(env, s);
  if (!feed) {
    const res = await fetchAndStoreFeed(env, { url: s, id: 0, etag: '', updated: 0, title: t });
    if (res.error || !res.feedId) return text('OK');
    feed = await getFeedByUrl(env, res.url);
  }
  if (!feed) return text('OK');

  const existing = await hasSubscription(env, user.id, feed.id);
  if (!existing) {
    await addSubscription(env, user.id, feed.id, t, labelsToAdd);
  } else {
    if (t) await updateSubscriptionTitle(env, user.id, feed.id, t);
    for (const l of labelsToAdd) await addSubscription(env, user.id, feed.id, '', [l]);
  }
  for (const l of labelsToRemove) await detachLabel(env, user.id, feed.id, l);
  return text('OK');
}

export async function tagList(request, env, user) {
  const specials = [
    ['user/-/state/com.google/reading-list', 'A0000001'],
    ['user/-/state/com.google/starred', 'A0000002'],
    ['user/-/state/com.google/broadcast', 'A0000003'],
    ['user/-/state/com.google/kept-unread', 'A0000004'],
  ];
  const tags = specials.map(([id, sortid]) => ({
    id: id.replace('user/-', `user/${user.id}`),
    sortid,
  }));
  const labels = await listTags(env, user.id);
  labels.forEach((l, i) => {
    tags.push({ id: `user/${user.id}/label/${l.name}`, sortid: 'B' + String(i).padStart(7, '0') });
  });
  return json({ tags });
}

export async function editTag(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const ids = url.searchParams.getAll('i').length
    ? url.searchParams.getAll('i')
    : form.getAll('i');
  const adds = url.searchParams.getAll('a').length
    ? url.searchParams.getAll('a')
    : form.getAll('a');
  const removes = url.searchParams.getAll('r').length
    ? url.searchParams.getAll('r')
    : form.getAll('r');
  for (const id of ids) {
    for (const a of adds) await applyTag(env, user, id, a, true);
    for (const r of removes) await applyTag(env, user, id, r, false);
  }
  return text('OK');
}

export async function markAllAsRead(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const s = form.get('s') || url.searchParams.get('s') || '';
  const tsRaw = form.get('ts') || url.searchParams.get('ts');
  const ts = tsRaw ? parseInt(tsRaw, 10) : null;
  if (!s) return text('OK');
  const stream = await resolveStreamId(env, s);
  if (stream.kind === 'unknown') return text('OK');
  await markStreamRead(env, user.id, stream, ts);
  return text('OK');
}

export async function renameTag(request, env, user) {
  const form = await readForm(request);
  const s = form.get('s') || form.get('t') || '';
  const dest = form.get('dest') || '';
  const oldName = stripLabel(s);
  const newName = stripLabel(dest);
  if (!oldName || !newName) return text('OK');
  await dbRenameTag(env, user.id, oldName, newName);
  return text('OK');
}

export async function disableTag(request, env, user) {
  const form = await readForm(request);
  const s = form.get('s') || form.get('t') || '';
  const name = stripLabel(s);
  if (!name) return text('OK');
  await dbDisableTag(env, user.id, name);
  return text('OK');
}

export async function preferences(request, env, user) {
  return json({
    prefs: [{ id: 'lhn-prefs', value: '{"subscriptions":{"ssa":"true"}}' }],
  });
}

export async function streamPreferences(request, env, user) {
  return json({ streamprefs: {} });
}

export async function friends(request, env, user) {
  return json({
    friends: [
      {
        p: '',
        contactId: '-1',
        flags: 1,
        stream: `user/${user.id}/state/com.google/broadcast`,
        hasSharedItemsOnProfile: false,
        profileIds: [String(user.id)],
        userIds: [String(user.id)],
        givenName: user.username,
        displayName: user.username,
        n: '',
      },
    ],
  });
}

export async function streamContents(request, env, user) {
  const url = new URL(request.url);
  const raw = request.url;
  const marker = '/reader/api/0/stream/contents/';
  let token = '';
  const idx = raw.indexOf(marker);
  if (idx !== -1) {
    let restRaw = raw.slice(idx + marker.length);
    const qi = restRaw.indexOf('?');
    if (qi !== -1) restRaw = restRaw.slice(0, qi);
    token = decodeURIComponentSafe(restRaw);
  }

  if (url.searchParams.get('s')) {
    token = url.searchParams.get('s').replace(/^user\/[^/]+\//, 'user/-/');
  }

  if (!token) {
    // Fluent Reader / EasyRSS / FeedMe call bare stream/contents with no stream id;
    // default to the user's reading list.
    token = 'user/-/state/com.google/reading-list';
  }

  const stream = await resolveStreamId(env, token);
  const opts = {
    order: url.searchParams.get('r') || '',
    limit: clampInt(url.searchParams.get('n'), 20, 1, 1000),
    offset: contDec(url.searchParams.get('c')),
    cursor: cursorDec(url.searchParams.get('c')),
    xtResolved: await resolveStreamIds(env, url.searchParams.getAll('xt')),
    itResolved: await resolveStreamIds(env, url.searchParams.getAll('it')),
    ot: url.searchParams.get('ot') ? parseInt(url.searchParams.get('ot'), 10) : null,
    nt: url.searchParams.get('nt') ? parseInt(url.searchParams.get('nt'), 10) : null,
  };

  const out = {
    direction: 'ltr',
    id: stream.kind === 'unknown' ? token : canonicalStreamId(stream, user.id),
    title: stream.kind === 'unknown' ? token : await streamTitle(env, stream, user.id, user.username),
    updated: now(),
    items: [],
  };
  out.self = [{ href: url.origin + url.pathname, id: out.id }];

  if (stream.kind !== 'unknown') {
    const { rows, hasMore } = await getItemsStream(env, user.id, stream, opts);
    const states = await getStatesForItems(env, user.id, rows.map((r) => r.id));
    const labels = await getLabelsForItems(env, user.id, rows.map((r) => r.id));
    out.items = rows.map((r) => itemToJson(r, user.id, states, labels));
    if (hasMore && rows.length) {
      const last = rows[rows.length - 1];
      out.continuation = cursorEnc(opts.order, last.published, last.id);
    }
  }

  const output = url.searchParams.get('output');
  if (output === 'atom' || output === 'xml') return atomContents(out, url.origin + url.pathname);
  return json(out);
}

export async function streamItemsIds(request, env, user) {
  const url = new URL(request.url);
  const s = url.searchParams.get('s') || '';
  if (!s) return json({ itemRefs: [] });
  const stream = await resolveStreamId(env, s);
  const opts = {
    order: url.searchParams.get('r') || '',
    limit: clampInt(url.searchParams.get('n'), 20, 1, 5000),
    offset: contDec(url.searchParams.get('c')),
    cursor: cursorDec(url.searchParams.get('c')),
    refsOnly: true,
    xtResolved: await resolveStreamIds(env, url.searchParams.getAll('xt')),
    itResolved: await resolveStreamIds(env, url.searchParams.getAll('it')),
    ot: url.searchParams.get('ot') ? parseInt(url.searchParams.get('ot'), 10) : null,
    nt: url.searchParams.get('nt') ? parseInt(url.searchParams.get('nt'), 10) : null,
  };
  const withDirect = url.searchParams.get('includeAllDirectStreamIds') === 'true';
  const out = { itemRefs: [] };
  if (stream.kind !== 'unknown') {
    const opts2 = withDirect ? { ...opts, refsOnly: false } : opts;
    const { rows, hasMore } = await getItemsStream(env, user.id, stream, opts2);
    const states = withDirect ? await getStatesForItems(env, user.id, rows.map((r) => r.id)) : null;
    out.itemRefs = rows.map((r) => {
      const ref = {
        id: String(Number(r.rowid ?? 0) || 0),
        timestampUsec: r.timestamp_usec,
      };
      if (withDirect) {
        const st = states[r.id] || new Set();
        const ds = ['user/-/state/com.google/reading-list', `feed/${r.feed_url}`];
        if (st.has('read')) ds.push('user/-/state/com.google/read');
        if (st.has('starred')) ds.push('user/-/state/com.google/starred');
        ref.directStreamIds = ds;
        ref.originalStreamIds = [];
      }
      return ref;
    });
    if (hasMore && rows.length) {
      const last = rows[rows.length - 1];
      out.continuation = cursorEnc(opts.order, last.published, last.id);
    }
  }
  return json(out);
}

export async function streamItemsContents(request, env, user) {
  const url = new URL(request.url);
  let ids = url.searchParams.getAll('i');
  if (!ids.length) {
    const form = await readForm(request);
    ids = form.getAll('i');
  }
  if (!ids.length) return json({ items: [] });
  const rows = await getItemsByIds(env, user.id, ids);
  const states = await getStatesForItems(env, user.id, ids);
  const labels = await getLabelsForItems(env, user.id, ids);
  return json({ items: rows.map((r) => itemToJson(r, user.id, states, labels)) });
}

export async function streamItemsCount(request, env, user) {
  const url = new URL(request.url);
  const s = url.searchParams.get('s') || '';
  if (!s) return text('0');
  const stream = await resolveStreamId(env, s);
  const opts = {
    xtResolved: await resolveStreamIds(env, url.searchParams.getAll('xt')),
    itResolved: await resolveStreamIds(env, url.searchParams.getAll('it')),
  };
  if (stream.kind === 'unknown') return text('0');
  const c = await countStreamItems(env, user.id, stream, opts);
  if (url.searchParams.get('a') === 'true') {
    const m = await latestStreamItem(env, user.id, stream, opts);
    const d = m
      ? new Date(m * 1000).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : '';
    return text(`${c}#${d}`);
  }
  return text(String(c));
}

export async function searchItemsIds(request, env, user) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  if (!q) return json({ results: [] });
  const rows = await searchItemsDb(env, user.id, q, {});
  return json({
    results: rows.map((r) => ({
      id: 'tag:google.com,2005:reader/item/' + (Number(r.rowid ?? 0) || 0).toString(16).padStart(16, '0'),
      timestampUsec: String(r.published * 1000000),
    })),
  });
}

export async function exportOpml(request, env, user) {
  const subs = await getSubscriptions(env, user.id);
  const labelMap = new Map();
  const unlabeled = [];
  for (const s of subs) {
    const entry = {
      title: s.custom_title || s.feed_title || s.feed_url,
      xmlUrl: s.feed_url,
      htmlUrl: s.feed_html || '',
    };
    const ls = s.labels || [];
    if (ls.length) {
      for (const l of ls) {
        if (!labelMap.has(l)) labelMap.set(l, []);
        labelMap.get(l).push(entry);
      }
    } else {
      unlabeled.push(entry);
    }
  }
  const groups = [];
  if (unlabeled.length) groups.push({ name: null, feeds: unlabeled });
  for (const [name, feeds] of labelMap) groups.push({ name, feeds });
  return xml(buildOpml(`${user.username}'s subscriptions`, groups), 200, 'text/xml; charset=utf-8');
}

export async function importOpml(request, env, user) {
  const raw = await request.text();
  let xmlStr = raw;
  if (!/^\s*<(opml|xml)/i.test(raw)) {
    try {
      const form = new URLSearchParams(raw);
      xmlStr = form.get('file') || form.get('opml') || raw;
    } catch (e) {
      /* keep raw */
    }
  }
  const feeds = parseOpml(xmlStr);
  let added = 0;
  for (const f of feeds) {
    let url = f.xmlUrl.replace(/^feed:\/\//i, 'https://');
    try {
      url = new URL(url).href;
    } catch (e) {
      continue;
    }
    let feed = await getFeedByUrl(env, url);
    if (!feed) {
      const res = await fetchAndStoreFeed(env, { url, id: 0, etag: '', updated: 0, title: f.title || '' });
      if (res.error || !res.feedId) continue;
      feed = await getFeedByUrl(env, res.url);
    }
    if (!feed) continue;
    if (!(await hasSubscription(env, user.id, feed.id))) {
      await addSubscription(env, user.id, feed.id, '', f.group ? [f.group] : []);
      added++;
    } else if (f.group) {
      await addSubscription(env, user.id, feed.id, '', [f.group]);
    }
  }
  return text(`OK added=${added}`);
}

export async function streamDetails(request, env, user) {
  return json({ errors: { error: [] }, warnings: { warning: [] } });
}

async function fetchTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function favicon(request, env, url) {
  const host = url.searchParams.get('host') || '';
  if (!host) return text('', 400);
  const cacheKey = 'fav:' + host.toLowerCase();
  if (env.KV) {
    try {
      const cached = await env.KV.get(cacheKey, 'arrayBuffer');
      if (cached) {
        return new Response(cached, {
          headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' },
        });
      }
    } catch (e) {
      /* ignore */
    }
  }
  const sources = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
  ];
  for (const src of sources) {
    try {
      const resp = await fetchTimeout(src);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (env.KV) {
          try {
            await env.KV.put(cacheKey, buf, { expirationTtl: 7 * 86400 });
          } catch (e) {
            /* ignore */
          }
        }
        return new Response(buf, {
          headers: {
            'Content-Type': resp.headers.get('content-type') || 'image/x-icon',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
    } catch (e) {
      /* ignore */
    }
  }
  return text('', 404);
}