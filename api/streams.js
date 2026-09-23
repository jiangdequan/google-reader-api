import { json, text, now } from '../util.js';
import {
  countStreamItems,
  getItemsByIds,
  getItemsStream,
  getLabelsForItems,
  getStatesForItems,
  latestStreamItem,
  resolveStreamId,
  searchItems as searchItemsDb,
} from '../db/items.js';
import {
  atomContents,
  canonicalStreamId,
  clampInt,
  contDec,
  cursorDec,
  cursorEnc,
  decodeURIComponentSafe,
  itemToJson,
  readForm,
  resolveStreamIds,
  streamTitle,
} from './utils.js';

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

  // GReader-compatible clients (e.g. Newsboat's FeedHQ backend) fetch
  // articles via /reader/atom/<stream?n=.. in Atom XML form.
  const atomIdx = raw.indexOf('/reader/atom/');
  if (!token && atomIdx !== -1) {
    let restRaw = raw.slice(atomIdx + '/reader/atom/'.length);
    const qi = restRaw.indexOf('?');
    if (qi !== -1) restRaw = restRaw.slice(0, qi);
    token = decodeURIComponentSafe(restRaw);
    url.searchParams.set('output', 'atom');
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
  const [xtResolved, itResolved] = await Promise.all([
    resolveStreamIds(env, url.searchParams.getAll('xt')),
    resolveStreamIds(env, url.searchParams.getAll('it')),
  ]);
  const opts = {
    order: url.searchParams.get('r') || '',
    limit: clampInt(url.searchParams.get('n'), 20, 1, 1000),
    offset: contDec(url.searchParams.get('c')),
    cursor: cursorDec(url.searchParams.get('c')),
    xtResolved,
    itResolved,
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
    const [states, labels] = await Promise.all([
      getStatesForItems(env, user.id, rows.map((r) => r.id)),
      getLabelsForItems(env, user.id, rows.map((r) => r.id)),
    ]);
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
  const [xtResolved, itResolved] = await Promise.all([
    resolveStreamIds(env, url.searchParams.getAll('xt')),
    resolveStreamIds(env, url.searchParams.getAll('it')),
  ]);
  const opts = {
    order: url.searchParams.get('r') || '',
    limit: clampInt(url.searchParams.get('n'), 20, 1, 5000),
    offset: contDec(url.searchParams.get('c')),
    cursor: cursorDec(url.searchParams.get('c')),
    refsOnly: true,
    xtResolved,
    itResolved,
    ot: url.searchParams.get('ot') ? parseInt(url.searchParams.get('ot'), 10) : null,
    nt: url.searchParams.get('nt') ? parseInt(url.searchParams.get('nt'), 10) : null,
  };
  const withDirect = url.searchParams.get('includeAllDirectStreamIds') === 'true';
  const out = { itemRefs: [] };
  if (stream.kind !== 'unknown') {
    const opts2 = withDirect ? { ...opts, refsOnly: false } : opts;
    const { rows, hasMore } = await getItemsStream(env, user.id, stream, opts2);
    const states = withDirect
      ? await getStatesForItems(env, user.id, rows.map((r) => r.id))
      : null;
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
  const [rows, states, labels] = await Promise.all([
    getItemsByIds(env, user.id, ids),
    getStatesForItems(env, user.id, ids),
    getLabelsForItems(env, user.id, ids),
  ]);
  return json({
    id: 'user/-/state/com.google/reading-list',
    updated: now(),
    items: rows.map((r) => itemToJson(r, user.id, states, labels)),
  });
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

export async function streamDetails(request, env, user) {
  return json({ errors: { error: [] }, warnings: { warning: [] } });
}