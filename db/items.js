import { now, sha1Hex } from '../util.js';
import { parseStreamId } from '../streamid.js';
import {
  DEFAULT_ITEM_AGE_DAYS,
  DEFAULT_MAX_ITEMS_PER_FEED,
  DEFAULT_PAGE_LIMIT,
  MAX_MARK_READ_ITEMS,
  SECONDS_PER_DAY,
  SEARCH_RESULT_LIMIT,
} from '../constants.js';
import { batchAll, BATCH_CHUNK, SQL_CHUNK } from './util.js';
import { getFeedById, getFeedByUrl } from './feeds.js';

export async function resolveStreamId(env, token) {
  const p = parseStreamId(token);
  if (p.kind === 'feed' && p.feedId !== undefined) {
    const f = await getFeedById(env, p.feedId);
    return { kind: 'feed', url: f ? f.url : '', feedId: f ? f.id : p.feedId };
  }
  if (p.kind === 'feed') {
    const f = await getFeedByUrl(env, p.url);
    return { kind: 'feed', url: p.url, feedId: f ? f.id : 0 };
  }
  return p;
}

export function buildStreamWhere(userId, stream, opts = {}) {
  const { xtResolved = [], itResolved = [], ot, nt } = opts;
  const labelClause = (name, tagAlias = 't', itemAlias = 'il') => ({
    sql: `(EXISTS (SELECT 1 FROM subscription_tags st JOIN tags ${tagAlias} ON ${tagAlias}.id=st.tag_id
                   WHERE st.user_id=? AND st.feed_id=i.feed_id AND ${tagAlias}.name=?)
           OR EXISTS (SELECT 1 FROM item_tags ${itemAlias} WHERE ${itemAlias}.user_id=? AND ${itemAlias}.item_id=i.id AND ${itemAlias}.label=?))`,
    args: [userId, name, userId, name],
  });

  // Per-item state predicate. Only materialized states (read/starred/broadcast/
  // kept-unread) map to item_states; reading-list/unread apply solely as the
  // stream itself (positive subscription EXISTS) and are no-ops as xt/it
  // filters, so this helper returns null for them in all cases.
  const stateClause = (state, alias = 's', negate = false) => {
    if (state === 'read' || state === 'starred' || state === 'broadcast' || state === 'kept-unread') {
      return {
        sql: `${negate ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM item_states ${alias} WHERE ${alias}.user_id=? AND ${alias}.item_id=i.id AND ${alias}.state=?)`,
        args: [userId, state],
      };
    }
    return null;
  };

  // Every subscribed feed's items form the reading-list.
  const readingListClause = () => ({
    sql: 'EXISTS (SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id)',
    args: [userId],
  });

  const feedClause = (feedId) => ({
    sql: 'i.feed_id = ?',
    args: [feedId],
  });

  const conditions = [];
  const add = (condition) => {
    if (condition) conditions.push(condition);
  };

  if (stream.kind === 'feed') {
    add(feedClause(stream.feedId));
  } else if (stream.kind === 'label') {
    add(labelClause(stream.name));
  } else if (stream.kind === 'state') {
    add(
      stream.state === 'reading-list' || stream.state === 'unread'
        ? readingListClause()
        : stateClause(stream.state),
    );
  }

  for (const x of xtResolved) {
    if (x.kind === 'feed' && x.feedId) {
      add({ sql: 'i.feed_id <> ?', args: [x.feedId] });
    } else if (x.kind === 'label') {
      const clause = labelClause(x.name);
      add({ sql: `NOT ${clause.sql}`, args: clause.args });
    } else if (x.kind === 'state') {
      add(stateClause(x.state, 's', true));
    }
  }

  const includes = [];
  for (const t of itResolved || []) {
    if (t.kind === 'feed' && t.feedId) {
      includes.push({
        sql: 'EXISTS (SELECT 1 FROM items t2 WHERE t2.id = i.id AND t2.feed_id = ?)',
        args: [t.feedId],
      });
    } else if (t.kind === 'label') {
      includes.push(labelClause(t.name, 'tg', 'il2'));
    } else if (t.kind === 'state') {
      const clause = stateClause(t.state, 's2');
      if (clause) includes.push(clause);
    }
  }

  if (includes.length) {
    add({
      sql: `(${includes.map((c) => c.sql).join(' OR ')})`,
      args: includes.flatMap((c) => c.args),
    });
  }

  if (ot) add({ sql: 'i.published >= ?', args: [ot] });
  if (nt) add({ sql: 'i.published <= ?', args: [nt] });

  const args = conditions.flatMap((c) => c.args);
  const where = conditions.length ? ' WHERE ' + conditions.map((c) => c.sql).join(' AND ') : '';
  return { where, args };
}

export async function getItemsStream(env, userId, stream, opts) {
  const { where, args } = buildStreamWhere(userId, stream, opts);
  const desc = opts.order !== 'o';
  const order = `i.published ${desc ? 'DESC' : 'ASC'}, i.id ${desc ? 'DESC' : 'ASC'}`;
  const limit = opts.limit || DEFAULT_PAGE_LIMIT;

  // Collect WHERE clauses and their bound params first, then append LIMIT/OFFSET.
  // Cursor pins an exact (published, id) pair and supersedes offset.
  const clauses = where ? [where.replace(/^\s*WHERE\s+/, '')] : [];
  const params = [...args];
  let tail = ` ORDER BY ${order} LIMIT ?`;
  if (opts.cursor) {
    const { published, id } = opts.cursor;
    const op = desc ? '<' : '>';
    clauses.push(`(i.published ${op} ? OR (i.published = ? AND i.id ${op} ?))`);
    params.push(published, published, id, limit + 1);
  } else if (opts.offset) {
    tail += ' OFFSET ?';
    params.push(limit + 1, opts.offset);
  } else {
    params.push(limit + 1);
  }
  const conds = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';

  if (opts.refsOnly) {
    // stream/items/ids only needs ids + timestamps; skip the feed join and payload columns.
    const res = await env.DB.prepare(
      `SELECT i.rowid, i.id, i.published, i.timestamp_usec FROM items i ${conds}${tail}`,
    )
      .bind(...params)
      .all();
    const rows = (res.results || []).slice(0, limit);
    return { rows, hasMore: (res.results || []).length > limit };
  }
  const res = await env.DB.prepare(
    `SELECT i.rowid, i.*, f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
     FROM items i JOIN feeds f ON f.id = i.feed_id
     ${conds}${tail}`,
  )
    .bind(...params)
    .all();
  return {
    rows: (res.results || []).slice(0, limit),
    hasMore: (res.results || []).length > limit,
  };
}

export async function countStreamItems(env, userId, stream, opts) {
  const { where, args } = buildStreamWhere(userId, stream, opts);
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items i ${where}`,
  )
    .bind(...args)
    .first();
  return r ? r.c : 0;
}

export async function latestStreamItem(env, userId, stream, opts) {
  const { where, args } = buildStreamWhere(userId, stream, opts);
  const r = await env.DB.prepare(
    `SELECT MAX(i.published) AS m FROM items i ${where}`,
  )
    .bind(...args)
    .first();
  return r ? r.m || 0 : 0;
}

// Keep items at most MAX_ITEM_AGE_DAYS old (default DEFAULT_ITEM_AGE_DAYS).
// Entries without a publish date (published=0) are always kept, otherwise feeds
// without dates would silently end up empty. Also de-duplicates candidates by
// guid.
function candidateItems(items, env) {
  const maxAge = Number(env.MAX_ITEM_AGE_DAYS) || DEFAULT_ITEM_AGE_DAYS;
  const cutoff = maxAge > 0 ? now() - maxAge * SECONDS_PER_DAY : 0;
  const candidates = [];
  const seen = new Set();
  for (const it of items) {
    if (!it.guid) continue;
    if (cutoff && it.published > 0 && it.published < cutoff) continue;
    if (seen.has(it.guid)) continue;
    seen.add(it.guid);
    candidates.push(it);
  }
  return candidates;
}

// Load stored (guid -> url) only for the incoming guids, chunked, instead of
// loading every stored guid of the feed into memory on each sync.
async function storedGuids(env, feedId, items) {
  const map = new Map();
  const checks = [];
  for (let i = 0; i < items.length; i += SQL_CHUNK) {
    const chunk = items.slice(i, i + SQL_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    checks.push(
      env.DB.prepare(
        `SELECT guid, url FROM items WHERE feed_id=? AND guid IN (${ph})`,
      ).bind(feedId, ...chunk.map((c) => c.guid)),
    );
  }
  for (const res of await batchAll(env, checks)) {
    for (const r of res.results || []) map.set(r.guid, r.url);
  }
  return map;
}

export async function insertNewItems(env, feedId, feedUrl, items) {
  if (!items.length) return 0;
  const candidates = candidateItems(items, env);
  if (!candidates.length) return 0;

  const existing = await storedGuids(env, feedId, candidates);
  const rows = [];
  const backfill = [];
  const tsNow = now() * 1000000;
  for (const it of candidates) {
    if (!existing.has(it.guid)) {
      rows.push({
        id: 'tag:google.com,2005:reader/item/' + (await sha1Hex(feedUrl + '\u0000' + it.guid)),
        guid: it.guid,
        url: it.url || '',
        title: it.title || '',
        author: it.author || '',
        content: it.content || '',
        enclosure: it.enclosure || '',
        published: it.published || 0,
        timestamp_usec: String(it.published > 0 ? it.published * 1000000 : tsNow),
        crawl_time: Date.now(),
      });
    } else if (it.url && !existing.get(it.guid)) {
      // The feed now provides a URL for an item that was stored without one.
      backfill.push(env.DB.prepare('UPDATE items SET url=? WHERE feed_id=? AND guid=?').bind(it.url, feedId, it.guid));
    }
  }

  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO items(id,feed_id,guid,url,title,author,content,enclosure,published,timestamp_usec,crawl_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const binds = rows.map((r) =>
    stmt.bind(r.id, feedId, r.guid, r.url, r.title, r.author, r.content, r.enclosure, r.published, r.timestamp_usec, r.crawl_time),
  );
  for (let i = 0; i < binds.length; i += BATCH_CHUNK) {
    await env.DB.batch(binds.slice(i, i + BATCH_CHUNK));
  }
  for (let i = 0; i < backfill.length; i += BATCH_CHUNK) {
    await env.DB.batch([...backfill.slice(i, i + BATCH_CHUNK), env.DB.prepare('SELECT 1')]);
  }
  return rows.length;
}

export async function pruneFeed(env, feedId, keep = DEFAULT_MAX_ITEMS_PER_FEED) {
  await env.DB.prepare(
    `DELETE FROM items WHERE feed_id=? AND id NOT IN (
       SELECT id FROM (SELECT id FROM items WHERE feed_id=? ORDER BY published DESC, id DESC LIMIT ?)
     )`,
  )
    .bind(feedId, feedId, keep)
    .run();
  await env.DB.prepare(
    'DELETE FROM item_states WHERE item_id NOT IN (SELECT id FROM items)',
  ).run();
  await env.DB.prepare(
    'DELETE FROM item_tags WHERE item_id NOT IN (SELECT id FROM items)',
  ).run();
}

export async function getStatesForItems(env, userId, ids) {
  const map = {};
  const unique = [...new Set(ids)];
  const stmts = [];
  for (let i = 0; i < unique.length; i += SQL_CHUNK) {
    const chunk = unique.slice(i, i + SQL_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    stmts.push(
      env.DB.prepare(
        `SELECT item_id, state FROM item_states WHERE user_id=? AND item_id IN (${ph})`,
      ).bind(userId, ...chunk),
    );
  }
  for (const res of await batchAll(env, stmts)) {
    for (const r of res.results || []) {
      (map[r.item_id] = map[r.item_id] || new Set()).add(r.state);
    }
  }
  return map;
}

export async function getLabelsForItems(env, userId, ids) {
  const map = {};
  const unique = [...new Set(ids)];
  const stmts = [];
  for (let i = 0; i < unique.length; i += SQL_CHUNK) {
    const chunk = unique.slice(i, i + SQL_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    stmts.push(
      env.DB.prepare(
        `SELECT item_id, label FROM item_tags WHERE user_id=? AND item_id IN (${ph})`,
      ).bind(userId, ...chunk),
    );
  }
  for (const res of await batchAll(env, stmts)) {
    for (const r of res.results || []) {
      (map[r.item_id] = map[r.item_id] || []).push(r.label);
    }
  }
  return map;
}

export async function setItemState(env, userId, itemId, state, on) {
  if (on) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO item_states(user_id, item_id, state) VALUES (?,?,?)',
    )
      .bind(userId, itemId, state)
      .run();
  } else {
    await env.DB.prepare(
      'DELETE FROM item_states WHERE user_id=? AND item_id=? AND state=?',
    )
      .bind(userId, itemId, state)
      .run();
  }
}

export async function setItemLabel(env, userId, itemId, label, on) {
  if (on) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO item_tags(user_id, item_id, label) VALUES (?,?,?)',
    )
      .bind(userId, itemId, label)
      .run();
  } else {
    await env.DB.prepare(
      'DELETE FROM item_tags WHERE user_id=? AND item_id=? AND label=?',
    )
      .bind(userId, itemId, label)
      .run();
  }
}

export async function markStreamRead(env, userId, stream, tsUsec) {
  const { where, args } = buildStreamWhere(userId, stream, {});

  // Collect WHERE clauses and their bound params first, then only decorate the
  // tail below (mirrors getItemsStream).
  const clauses = where ? [where.replace(/^\s*WHERE\s+/, '')] : [];
  const params = [...args];
  if (tsUsec) {
    clauses.push('i.published <= ?');
    params.push(Math.floor(tsUsec / 1e6));
  }
  const conds = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';

  const res = await env.DB.prepare(
    `SELECT i.id FROM items i ${conds} ORDER BY i.published DESC LIMIT ${MAX_MARK_READ_ITEMS}`,
  )
    .bind(...params)
    .all();
  const ids = (res.results || []).map((r) => r.id);
  const stmts = ids.map((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO item_states(user_id, item_id, state) VALUES (?,?,?)',
    ).bind(userId, id, 'read'),
  );
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    await env.DB.batch(stmts.slice(i, i + BATCH_CHUNK));
  }
  return ids.length;
}

export async function getItemsByIds(env, ids) {
  if (!ids.length) return [];
  const rowids = [];
  const idsLong = [];
  for (const raw of ids) {
    const v = String(raw || '').trim();
    if (/^\d+$/.test(v)) {
      rowids.push(v);
      continue;
    }
    const tagMatch = v.match(/^tag:google\.com,2005:reader\/item\/([0-9a-fA-F]+)$/);
    if (tagMatch && tagMatch[1].length <= 16) {
      const n = parseInt(tagMatch[1], 16);
      if (Number.isSafeInteger(n) && n > 0) rowids.push(String(n));
      continue;
    }
    const hex16 = v.match(/^[0-9a-fA-F]{16}$/);
    if (hex16) {
      const n = parseInt(hex16[0], 16);
      if (Number.isSafeInteger(n) && n > 0) rowids.push(String(n));
      continue;
    }
    idsLong.push(v);
  }
  const rows = [];
  const stmts = [];
  const build = (values, column) => {
    for (let i = 0; i < values.length; i += SQL_CHUNK) {
      const chunk = values.slice(i, i + SQL_CHUNK);
      stmts.push(
        env.DB.prepare(
          `SELECT i.rowid, i.*, f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
           FROM items i JOIN feeds f ON f.id = i.feed_id
           WHERE i.${column} IN (${chunk.map(() => '?').join(',')})`,
        ).bind(...chunk),
      );
    }
  };
  build(rowids, 'rowid');
  build(idsLong, 'id');
  for (const res of await batchAll(env, stmts)) {
    rows.push(...(res.results || []));
  }
  return rows;
}

export async function searchItems(env, userId, q, opts) {
  const like = '%' + String(q).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
  const { where, args } = buildStreamWhere(userId, { kind: 'state', state: 'reading-list' }, {});
  let sql =
    `SELECT i.rowid, i.id, i.published FROM items i` +
    (where ? ` ${where}` : '') +
    (where ? ' AND ' : ' WHERE ') +
    ` (i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\')`;
  const res = await env.DB.prepare(
    sql + ` ORDER BY i.published DESC, i.id DESC LIMIT ${SEARCH_RESULT_LIMIT}`,
  )
    .bind(...args, like, like)
    .all();
  return res.results || [];
}