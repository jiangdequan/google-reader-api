import { decodeURIComponentSafe, json, now, text } from '../util.js';
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
import { atomContents, itemToJson } from './atom-view.js';
import { buildStreamOpts, cursorEnc, readForm } from './http.js';
import { canonicalStreamId, streamTitle } from './stream-parser.js';

// Extracts the requested stream id from the path or `s` param, in the same
// precedence as Reader clients send them: `/stream/contents/<id>` and
// `/reader/atom/<id>` paths, then an explicit `s=` override, then the
// reading list as the default. The atom path also flips the render format.
function streamToken(request) {
  const url = new URL(request.url);
  const raw = request.url;
  let token = '';
  const idx = raw.indexOf('/reader/api/0/stream/contents/');
  if (idx !== -1) {
    let rest = raw.slice(idx + '/reader/api/0/stream/contents/'.length);
    const qi = rest.indexOf('?');
    if (qi !== -1) rest = rest.slice(0, qi);
    token = decodeURIComponentSafe(rest);
  }

  // GReader-compatible clients (e.g. Newsboat's FeedHQ backend) fetch
  // articles via /reader/atom/<stream>?n=.. in Atom XML form.
  const atomIdx = raw.indexOf('/reader/atom/');
  if (!token && atomIdx !== -1) {
    let rest = raw.slice(atomIdx + '/reader/atom/'.length);
    const qi = rest.indexOf('?');
    if (qi !== -1) rest = rest.slice(0, qi);
    url.searchParams.set('output', 'atom');
    token = decodeURIComponentSafe(rest);
  }

  const s = url.searchParams.get('s');
  if (s) token = s.replace(/^user\/[^/]+\//, 'user/-/');

  // Fluent Reader / EasyRSS / FeedMe call bare stream/contents with no stream id.
  return { url, token: token || 'user/-/state/com.google/reading-list' };
}

export async function streamContents(request, env, user) {
  const { url, token } = streamToken(request);
  const stream = await resolveStreamId(env, token);
  const opts = await buildStreamOpts(url, env);
  const out = {
    direction: 'ltr',
    id: stream.kind === 'unknown' ? token : canonicalStreamId(stream),
    title: stream.kind === 'unknown' ? token : await streamTitle(env, stream, user.username),
    updated: now(),
    items: [],
  };
  out.self = [{ href: url.origin + url.pathname, id: out.id }];
  await loadStreamItems(env, user, stream, opts, out);
  const output = url.searchParams.get('output');
  if (output === 'atom' || output === 'xml') return atomContents(out, url.origin + url.pathname);
  return json(out);
}

async function loadStreamItems(env, user, stream, opts, out) {
  if (stream.kind === 'unknown') return;
  const { rows, hasMore } = await getItemsStream(env, user.id, stream, opts);
  const [states, labels] = await Promise.all([
    getStatesForItems(
      env,
      user.id,
      rows.map((r) => r.id),
    ),
    getLabelsForItems(
      env,
      user.id,
      rows.map((r) => r.id),
    ),
  ]);
  out.items = rows.map((r) => itemToJson(r, states, labels));
  if (hasMore && rows.length) {
    const last = rows[rows.length - 1];
    out.continuation = cursorEnc(opts.order, last.published, last.id);
  }
}

export async function streamItemsIds(request, env, user) {
  const url = new URL(request.url);
  const s = url.searchParams.get('s') || '';
  if (!s) return json({ itemRefs: [] });
  const stream = await resolveStreamId(env, s);
  const withDirect = url.searchParams.get('includeAllDirectStreamIds') === 'true';
  const opts = await buildStreamOpts(url, env, { refsOnly: !withDirect, maxLimit: 5000 });
  const out = { itemRefs: [] };
  if (stream.kind !== 'unknown') {
    const { rows, hasMore } = await getItemsStream(env, user.id, stream, opts);
    const states = withDirect
      ? await getStatesForItems(
          env,
          user.id,
          rows.map((r) => r.id),
        )
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
    getItemsByIds(env, ids),
    getStatesForItems(env, user.id, ids),
    getLabelsForItems(env, user.id, ids),
  ]);
  return json({
    id: 'user/-/state/com.google/reading-list',
    updated: now(),
    items: rows.map((r) => itemToJson(r, states, labels)),
  });
}

export async function streamItemsCount(request, env, user) {
  const url = new URL(request.url);
  const s = url.searchParams.get('s') || '';
  if (!s) return text('0');
  const stream = await resolveStreamId(env, s);
  if (stream.kind === 'unknown') return text('0');
  const opts = await buildStreamOpts(url, env, { paging: false });
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
