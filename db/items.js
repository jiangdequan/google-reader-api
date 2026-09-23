import { now, sha1Hex } from '../util.js';
import { batchAll, SQL_CHUNK } from './util.js';
import { getFeedById, getFeedByUrl } from './feeds.js';

export async function resolveStreamId(env, token) {
  let s = String(token || '').trim();
  s = s.replace(/^feed\/(http[s]?):\/([^/])/, '$1://$$2');
  s = s.replace(/^user\/[^/]+\//, 'user/-/');
  if (/^feed\/\d+$/.test(s)) {
    const fid = Number(s.slice(5));
    const f = await getFeedById(env, fid);
    return { kind: 'feed', url: f ? f.url : '', feedId: f ? f.id : fid };
  }
  if (s.startsWith('feed/http') || s.startsWith('feed/https')) {
    const url = s.slice(5);
    const f = await getFeedByUrl(env, url);
    return { kind: 'feed', url, feedId: f ? f.id : 0 };
  }
  if (s.startsWith('user/-/state/com.google/')) {
    return { kind: 'state', state: s.replace(/^user\/-\/state\/com\.google\//, '') };
  }
  if (s.startsWith('user/-/label/')) {
    return { kind: 'label', name: s.replace(/^user\/-\/label\//, '') };
  }
  return { kind: 'unknown' };
}

export function buildStreamWhere(userId, stream, xtResolved = [], ot, nt, itResolved = []) {
  const labelClause = (name, tagAlias = 't', itemAlias = 'il') => ({
    sql: `(EXISTS (SELECT 1 FROM subscription_tags st JOIN tags ${tagAlias} ON ${tagAlias}.id=st.tag_id
                   WHERE st.user_id=? AND st.feed_id=i.feed_id AND ${tagAlias}.name=?)
           OR EXISTS (SELECT 1 FROM item_tags ${itemAlias} WHERE ${itemAlias}.user_id=? AND ${itemAlias}.item_id=i.id AND ${itemAlias}.label=?))`,
    args: [userId, name, userId, name],
  });

  const stateClause = (state, alias = 's', negate = false) => {
    if (state === 'reading-list' || state === 'unread') {
      return {
        sql: 'EXISTS (SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id)',
        args: [userId],
      };
    }
    if (state === 'read' || state === 'starred' || state === 'broadcast' || state === 'kept-unread') {
      return {
        sql: `${negate ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM item_states ${alias} WHERE ${alias}.user_id=? AND ${alias}.item_id=i.id AND ${alias}.state=?)`,
        args: [userId, state],
      };
    }
    return null;
  };

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
    add(stateClause(stream.state));
  }

  for (const x of xtResolved || []) {
    if (x.kind === 'feed' && x.feedId) {
      add({ sql: 'i.feed_id <> ?', args: [x.feedId] });
    } else if (x.kind === 'label') {
      const clause = labelClause(x.name);
      add({ sql: `NOT ${clause.sql}`, args: clause.args });
    } else if (x.kind === 'state') {
      const clause = stateClause(x.state, 's', true);
      if (clause && !(x.state === 'reading-list' || x.state === 'unread')) {
        add(clause);
      }
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
      if (clause && !(t.state === 'reading-list' || t.state === 'unread')) {
        includes.push(clause);
      }
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
  const { where, args } = buildStreamWhere(
    userId,
    stream,
    opts.xtResolved || [],
    opts.ot,
    opts.nt,
    opts.itResolved || [],
  );
  const desc = opts.order !== 'o';
  const order = `i.published ${desc ? 'DESC' : 'ASC'}, i.id ${desc ? 'DESC' : 'ASC'}`;
  const limit = opts.limit || 20;
  let conds = where;
  const a = [...args];
  let tail = ` ORDER BY ${order} LIMIT ?`;
  if (opts.cursor) {
    const c = opts.cursor;
    const op = desc ? '<' : '>';
    conds +=
      (conds ? ' AND ' : ' WHERE ') +
      `(i.published ${op} ? OR (i.published = ? AND i.id ${op} ?))`;
    a.push(c.published, c.published, c.id, limit + 1);
  } else if (opts.offset) {
    tail += ' OFFSET ?';
    a.push(limit + 1, opts.offset);
  } else {
    a.push(limit + 1);
  }
  if (opts.refsOnly) {
    // stream/items/ids only needs ids + timestamps; skip the feed join and payload columns.
    const res = await env.DB.prepare(
      `SELECT i.rowid, i.id, i.published, i.timestamp_usec FROM items i ${conds}${tail}`,
    )
      .bind(...a)
      .all();
    const rows = (res.results || []).slice(0, limit);
    return { rows, hasMore: (res.results || []).length > limit };
  }
  const res = await env.DB.prepare(
    `SELECT i.rowid, i.*, f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
     FROM items i JOIN feeds f ON f.id = i.feed_id
     ${conds}${tail}`,
  )
    .bind(...a)
    .all();
  return {
    rows: (res.results || []).slice(0, limit),
    hasMore: (res.results || []).length > limit,
  };
}

export async function countStreamItems(env, userId, stream, opts) {
  const { where, args } = buildStreamWhere(
    userId,
    stream,
    opts.xtResolved || [],
    opts.ot,
    opts.nt,
    opts.itResolved || [],
  );
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items i ${where}`,
  )
    .bind(...args)
    .first();
  return r ? r.c : 0;
}

export async function latestStreamItem(env, userId, stream, opts) {
  const { where, args } = buildStreamWhere(
    userId,
    stream,
    opts.xtResolved || [],
    opts.ot,
    opts.nt,
    opts.itResolved || [],
  );
  const r = await env.DB.prepare(
    `SELECT MAX(i.published) AS m FROM items i ${where}`,
  )
    .bind(...args)
    .first();
  return r ? r.m || 0 : 0;
}

export async function insertNewItems(env, feedId, feedUrl, items) {
  if (!items.length) return 0;
  // Skip entries older than MAX_ITEM_AGE_DAYS (default 90). Entries without a
  // publish date (published=0) are always kept, otherwise feeds without dates
  // would silently end up empty.
  const maxAge = Number(env.MAX_ITEM_AGE_DAYS) || 90;
  const cutoff = maxAge > 0 ? now() - maxAge * 86400 : 0;
  const candidates = [];
  const seen = new Set();
  for (const it of items) {
    if (!it.guid) continue;
    if (cutoff && it.published > 0 && it.published < cutoff) continue;
    if (seen.has(it.guid)) continue;
    seen.add(it.guid);
    candidates.push(it);
  }
  if (!candidates.length) return 0;
  // Only check existence for the incoming guids (chunked), instead of loading
  // every stored guid of the feed into memory on each sync.
  const existingMap = new Map();
  const checks = [];
  for (let i = 0; i < candidates.length; i += SQL_CHUNK) {
    const chunk = candidates.slice(i, i + SQL_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    checks.push(
      env.DB.prepare(
        `SELECT guid, url FROM items WHERE feed_id=? AND guid IN (${ph})`,
      ).bind(feedId, ...chunk.map((c) => c.guid)),
    );
  }
  for (const res of await batchAll(env, checks)) {
    for (const r of res.results || []) existingMap.set(r.guid, r.url);
  }
  const rows = [];
  const backfill = [];
  const tsNow = now() * 1000000;
  for (const it of candidates) {
    if (!existingMap.has(it.guid)) {
      const id = 'tag:google.com,2005:reader/item/' + (await sha1Hex(feedUrl + '\u0000' + it.guid));
      rows.push({
        id,
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
    } else if (it.url && !existingMap.get(it.guid)) {
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
  for (let i = 0; i < binds.length; i += 80) {
    await env.DB.batch(binds.slice(i, i + 80));
  }
  for (let i = 0; i < backfill.length; i += 80) {
    const batch = [...backfill.slice(i, i + 80), env.DB.prepare('SELECT 1')];
    await env.DB.batch(batch.slice(0, 90));
  }
  return rows.length;
}

export async function pruneFeed(env, feedId, keep = 3000) {
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
  const { where, args } = buildStreamWhere(userId, stream, [], null, null);
  let conds = where;
  const a = [...args];
  if (tsUsec) {
    const t = Math.floor(tsUsec / 1e6);
    conds += (conds ? ' AND ' : ' WHERE ') + 'i.published <= ?';
    a.push(t);
  }
  const res = await env.DB.prepare(
    `SELECT i.id FROM items i ${conds} ORDER BY i.published DESC LIMIT 10000`,
  )
    .bind(...a)
    .all();
  const ids = (res.results || []).map((r) => r.id);
  const stmts = ids.map((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO item_states(user_id, item_id, state) VALUES (?,?,?)',
    ).bind(userId, id, 'read'),
  );
  for (let i = 0; i < stmts.length; i += 80) {
    await env.DB.batch(stmts.slice(i, i + 80));
  }
  return ids.length;
}

export async function getItemsByIds(env, userId, ids) {
  if (!ids.length) return [];
  const rowids = [];
  const idsLong = [];
  for (const raw of ids) {
    const v = String(raw || '').trim();
    let m = null;
    if (/^\d+$/.test(v)) {
      rowids.push(v);
    } else if ((m = v.match(/^tag:google\.com,2005:reader\/item\/([0-9a-fA-F]+)$/)) && m[1].length <= 16) {
      const n = parseInt(m[1], 16);
      if (Number.isSafeInteger(n) && n > 0) rowids.push(String(n));
    } else if ((m = v.match(/^[0-9a-fA-F]{16}$/))) {
      const n = parseInt(m[0], 16);
      if (Number.isSafeInteger(n) && n > 0) rowids.push(String(n));
    } else {
      idsLong.push(v);
    }
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
  const { where, args } = buildStreamWhere(userId, { kind: 'state', state: 'reading-list' }, [], null, null);
  let sql =
    `SELECT i.rowid, i.id, i.published FROM items i` +
    (where ? ` ${where}` : '') +
    (where ? ' AND ' : ' WHERE ') +
    ` (i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\')`;
  const res = await env.DB.prepare(
    sql + ` ORDER BY i.published DESC, i.id DESC LIMIT 1000`,
  )
    .bind(...args, like, like)
    .all();
  return res.results || [];
}