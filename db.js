import { now, randomHex, sha1Hex, sha256Hex } from './util.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    html_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    last_fetched INTEGER NOT NULL DEFAULT 0,
    fetch_error TEXT NOT NULL DEFAULT '',
    etag TEXT NOT NULL DEFAULT '',
    updated INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER NOT NULL,
    feed_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, feed_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (user_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS subscription_tags (
    user_id INTEGER NOT NULL,
    feed_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, feed_id, tag_id)
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    feed_id INTEGER NOT NULL,
    guid TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    enclosure TEXT NOT NULL DEFAULT '',
    published INTEGER NOT NULL DEFAULT 0,
    timestamp_usec TEXT NOT NULL DEFAULT '0',
    crawl_time INTEGER NOT NULL DEFAULT 0,
    UNIQUE (feed_id, guid)
  )`,
  `CREATE TABLE IF NOT EXISTS item_states (
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id, state)
  )`,
  `CREATE TABLE IF NOT EXISTS item_tags (
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id, label)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_feed_pub ON items(feed_id, published)`,
  `CREATE INDEX IF NOT EXISTS idx_items_pub ON items(published)`,
  `CREATE INDEX IF NOT EXISTS idx_states ON item_states(user_id, item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_item_tags ON item_tags(user_id, item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subtags ON subscription_tags(user_id, feed_id)`,
];

const schemaReady = new WeakMap();

export async function ensureSchema(env) {
  if (schemaReady.has(env)) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady.set(env, true);
}

export async function hashPassword(password, salt) {
  return await sha256Hex(salt + ':' + password);
}

export async function createUser(env, username, password) {
  const salt = randomHex(8);
  const pwh = await hashPassword(password, salt);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO users(username, password_hash, created_at) VALUES (?,?,?)',
  )
    .bind(username, 'sha256:' + salt + ':' + pwh, now())
    .run();
  return await getUserByUsername(env, username);
}

export async function ensureDefaultUsers(env) {
  const raw =
    env.GR_USERS ||
    (env.GR_USERNAME && env.GR_PASSWORD
      ? `${env.GR_USERNAME}:${env.GR_PASSWORD}`
      : '');
  if (!raw) return;
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const u = part.slice(0, idx).trim();
    const p = part.slice(idx + 1);
    if (!u || !p) continue;
    const existing = await env.DB.prepare('SELECT id FROM users WHERE username=?')
      .bind(u)
      .first();
    if (!existing) await createUser(env, u, p);
  }
}

export async function getUserByUsername(env, username) {
  return await env.DB.prepare('SELECT * FROM users WHERE username=?')
    .bind(username)
    .first();
}

export async function getUserById(env, id) {
  return await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
}

export async function verifyPassword(env, username, password) {
  if (!username || password === undefined || password === null) return null;
  const row = await getUserByUsername(env, username);
  if (!row) return null;
  const [scheme, salt, stored] = (row.password_hash || '').split(':');
  if (scheme !== 'sha256' || !salt || !stored) return null;
  const h = await hashPassword(password, salt);
  return h === stored ? row : null;
}

export async function getFeedByUrl(env, url) {
  return await env.DB.prepare('SELECT * FROM feeds WHERE url=?').bind(url).first();
}

export async function getFeedById(env, id) {
  return await env.DB.prepare('SELECT * FROM feeds WHERE id=?').bind(id).first();
}

export async function insertFeed(env, meta) {
  const existing = await getFeedByUrl(env, meta.url);
  if (existing) {
    await env.DB.prepare(
      'UPDATE feeds SET title=?, html_url=?, description=?, etag=?, updated=? WHERE id=?',
    )
      .bind(
        meta.title || existing.title,
        meta.htmlUrl || existing.html_url,
        meta.description || '',
        meta.etag || '',
        meta.updated || existing.updated,
        existing.id,
      )
      .run();
    return { id: existing.id, created: false };
  }
  const res = await env.DB.prepare(
    'INSERT INTO feeds(url,title,html_url,description,etag,updated) VALUES (?,?,?,?,?,?)',
  )
    .bind(meta.url, meta.title || '', meta.htmlUrl || '', meta.description || '', meta.etag || '', meta.updated || 0)
    .run();
  return { id: res.meta.last_row_id, created: true };
}

export async function updateFetchMeta(env, feedId, { error, etag, updated }) {
  await env.DB.prepare(
    'UPDATE feeds SET last_fetched=?, fetch_error=?, etag=?, updated=? WHERE id=?',
  )
    .bind(now(), error || '', etag || '', updated || 0, feedId)
    .run();
}

export async function staleFeeds(env, since, limit) {
  const res = await env.DB.prepare(
    'SELECT * FROM feeds WHERE last_fetched < ? ORDER BY last_fetched ASC LIMIT ?',
  )
    .bind(since, limit)
    .all();
  return res.results || [];
}

export async function addSubscription(env, userId, feedId, title, labels = []) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO subscriptions(user_id, feed_id, title) VALUES (?,?,?)',
  )
    .bind(userId, feedId, title || '')
    .run();
  for (const l of labels) {
    if (l) await attachLabel(env, userId, feedId, l);
  }
}

export async function removeSubscription(env, userId, feedId) {
  await env.DB.prepare('DELETE FROM subscriptions WHERE user_id=? AND feed_id=?')
    .bind(userId, feedId)
    .run();
  await env.DB.prepare(
    'DELETE FROM subscription_tags WHERE user_id=? AND feed_id=?',
  )
    .bind(userId, feedId)
    .run();
}

export async function hasSubscription(env, userId, feedId) {
  return await env.DB.prepare(
    'SELECT 1 AS one FROM subscriptions WHERE user_id=? AND feed_id=?',
  )
    .bind(userId, feedId)
    .first();
}

export async function updateSubscriptionTitle(env, userId, feedId, title) {
  await env.DB.prepare(
    'UPDATE subscriptions SET title=? WHERE user_id=? AND feed_id=?',
  )
    .bind(title || '', userId, feedId)
    .run();
}

export async function ensureTag(env, userId, name) {
  let row = await env.DB.prepare('SELECT * FROM tags WHERE user_id=? AND name=?')
    .bind(userId, name)
    .first();
  if (!row) {
    await env.DB.prepare('INSERT INTO tags(user_id, name) VALUES (?,?)')
      .bind(userId, name)
      .run();
    row = await env.DB.prepare('SELECT * FROM tags WHERE user_id=? AND name=?')
      .bind(userId, name)
      .first();
  }
  return row;
}

export async function attachLabel(env, userId, feedId, name) {
  const tag = await ensureTag(env, userId, name);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO subscription_tags(user_id, feed_id, tag_id) VALUES (?,?,?)',
  )
    .bind(userId, feedId, tag.id)
    .run();
}

export async function detachLabel(env, userId, feedId, name) {
  const tag = await env.DB.prepare('SELECT * FROM tags WHERE user_id=? AND name=?')
    .bind(userId, name)
    .first();
  if (!tag) return;
  await env.DB.prepare(
    'DELETE FROM subscription_tags WHERE user_id=? AND feed_id=? AND tag_id=?',
  )
    .bind(userId, feedId, tag.id)
    .run();
}

export async function renameTag(env, userId, oldName, newName) {
  await env.DB.prepare('UPDATE tags SET name=? WHERE user_id=? AND name=?')
    .bind(newName, userId, oldName)
    .run();
}

export async function disableTag(env, userId, name) {
  const tag = await env.DB.prepare('SELECT * FROM tags WHERE user_id=? AND name=?')
    .bind(userId, name)
    .first();
  if (!tag) return;
  await env.DB.prepare('DELETE FROM subscription_tags WHERE tag_id=?')
    .bind(tag.id)
    .run();
  await env.DB.prepare('DELETE FROM tags WHERE id=?').bind(tag.id).run();
}

export async function listTags(env, userId) {
  const res = await env.DB.prepare('SELECT * FROM tags WHERE user_id=? ORDER BY name ASC')
    .bind(userId)
    .all();
  return res.results || [];
}

export async function getSubscriptions(env, userId) {
  const subs = await env.DB.prepare(
    `SELECT s.user_id, s.feed_id, s.title AS custom_title,
            f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
     FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
     WHERE s.user_id = ?
     ORDER BY (CASE WHEN s.title='' THEN f.title ELSE s.title END) ASC`,
  )
    .bind(userId)
    .all();
  const out = [];
  for (const s of subs.results || []) {
    const labels = await env.DB.prepare(
      `SELECT t.name FROM subscription_tags st JOIN tags t ON t.id = st.tag_id
       WHERE st.user_id=? AND st.feed_id=? ORDER BY t.name ASC`,
    )
      .bind(userId, s.feed_id)
      .all();
    out.push({ ...s, labels: (labels.results || []).map((l) => l.name) });
  }
  return out;
}

export async function latestTimestamps(env, feedIds) {
  if (!feedIds.length) return {};
  const ph = feedIds.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT feed_id, MAX(published)*1000 AS m FROM items WHERE feed_id IN (${ph}) GROUP BY feed_id`,
  )
    .bind(...feedIds)
    .all();
  const map = {};
  for (const r of res.results || []) map[r.feed_id] = r.m;
  return map;
}

export async function insertNewItems(env, feedId, feedUrl, items) {
  if (!items.length) return 0;
  const existingMap = new Map(
    (await env.DB.prepare('SELECT guid, url FROM items WHERE feed_id=?').bind(feedId).all())
      .results.map((r) => [r.guid, r.url]),
  );
  const rows = [];
  const backfill = [];
  const tsNow = now() * 1000000;
  for (const it of items) {
    if (!it.guid) continue;
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

export async function feedUnread(env, userId) {
  const res = await env.DB.prepare(
    `SELECT i.feed_id AS feed_id, COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     WHERE NOT EXISTS (
       SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='read'
     )
     GROUP BY i.feed_id`,
  )
    .bind(userId)
    .all();
  return res.results || [];
}

export async function labelUnread(env, userId) {
  const res = await env.DB.prepare(
    `SELECT t.name AS name, COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     JOIN subscription_tags st ON st.feed_id = i.feed_id AND st.user_id = ?
     JOIN tags t ON t.id = st.tag_id AND t.user_id = ?
     WHERE NOT EXISTS (
       SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='read'
     )
     GROUP BY t.name`,
  )
    .bind(userId, userId, userId)
    .all();
  return res.results || [];
}

export async function readingListUnread(env, userId) {
  return await env.DB.prepare(
    `SELECT COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     WHERE NOT EXISTS (
       SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='read'
     )`,
  )
    .bind(userId)
    .first();
}

export async function starredUnread(env, userId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items i
     WHERE EXISTS (SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='starred')
       AND NOT EXISTS (SELECT 1 FROM item_states s2 WHERE s2.user_id=? AND s2.item_id=i.id AND s2.state='read')`,
  )
    .bind(userId, userId)
    .first();
  return r ? r.c : 0;
}

export async function resolveStreamId(env, token) {
  let s = String(token || '').trim();
  s = s.replace(/^feed\/(http[s]?):\/([^/])/, '$1://$$2');
  s = s.replace(/^user\/[^/]+\//, 'user/-/');
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
  const conds = [];
  const args = [];
  const add = (sql, ...a) => {
    conds.push(sql);
    args.push(...a);
  };
  if (stream.kind === 'feed') {
    add('i.feed_id = ?', stream.feedId);
  } else if (stream.kind === 'label') {
    add(
      `(EXISTS (SELECT 1 FROM subscription_tags st JOIN tags t ON t.id=st.tag_id
                WHERE st.user_id=? AND st.feed_id=i.feed_id AND t.name=?)
        OR EXISTS (SELECT 1 FROM item_tags il WHERE il.user_id=? AND il.item_id=i.id AND il.label=?))`,
      userId,
      stream.name,
      userId,
      stream.name,
    );
  } else if (stream.kind === 'state') {
    const st = stream.state;
    if (st === 'starred' || st === 'broadcast' || st === 'kept-unread' || st === 'read') {
      add(
        'EXISTS (SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state=?)',
        userId,
        st,
      );
    }
  }
  for (const x of xtResolved || []) {
    if (x.kind === 'feed' && x.feedId) {
      add('i.feed_id <> ?', x.feedId);
    } else if (x.kind === 'label') {
      add(
        `NOT (EXISTS (SELECT 1 FROM subscription_tags st JOIN tags t ON t.id=st.tag_id
                      WHERE st.user_id=? AND st.feed_id=i.feed_id AND t.name=?)
           OR EXISTS (SELECT 1 FROM item_tags il WHERE il.user_id=? AND il.item_id=i.id AND il.label=?))`,
        userId,
        x.name,
        userId,
        x.name,
      );
    } else if (x.kind === 'state') {
      const st = x.state;
      if (st === 'read' || st === 'starred' || st === 'broadcast' || st === 'kept-unread') {
        add(
          'NOT EXISTS (SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state=?)',
          userId,
          st,
        );
      }
    }
  }
  const inc = [];
  const incArgs = [];
  for (const t of itResolved || []) {
    if (t.kind === 'feed' && t.feedId) {
      inc.push('EXISTS (SELECT 1 FROM items t2 WHERE t2.id = i.id AND t2.feed_id = ?)');
      incArgs.push(t.feedId);
    } else if (t.kind === 'label') {
      inc.push(
        `(EXISTS (SELECT 1 FROM subscription_tags st JOIN tags tg ON tg.id=st.tag_id
                  WHERE st.user_id=? AND st.feed_id=i.feed_id AND tg.name=?)
          OR EXISTS (SELECT 1 FROM item_tags il2 WHERE il2.user_id=? AND il2.item_id=i.id AND il2.label=?))`,
      );
      incArgs.push(userId, t.name, userId, t.name);
    } else if (t.kind === 'state') {
      const st = t.state;
      if (st === 'reading-list' || st === 'unread') continue;
      if (st === 'read' || st === 'starred' || st === 'broadcast' || st === 'kept-unread') {
        inc.push('EXISTS (SELECT 1 FROM item_states s2 WHERE s2.user_id=? AND s2.item_id=i.id AND s2.state=?)');
        incArgs.push(userId, st);
      }
    }
  }
  if (inc.length) add('(' + inc.join(' OR ') + ')', ...incArgs);
  if (ot) add('i.published >= ?', ot);
  if (nt) add('i.published <= ?', nt);
  return { where: conds.length ? ' WHERE ' + conds.join(' AND ') : '', args };
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
  const offset = opts.offset || 0;
  const res = await env.DB.prepare(
    `SELECT i.rowid, i.*, f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
     FROM items i JOIN feeds f ON f.id = i.feed_id
     ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...args, limit + 1, offset)
    .all();
  return {
    rows: (res.results || []).slice(0, limit),
    hasMore: (res.results || []).length > limit,
    nextOffset: offset + limit,
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

export async function getStatesForItems(env, userId, ids) {
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT item_id, state FROM item_states WHERE user_id=? AND item_id IN (${ph})`,
  )
    .bind(userId, ...ids)
    .all();
  const map = {};
  for (const r of res.results || []) {
    (map[r.item_id] = map[r.item_id] || new Set()).add(r.state);
  }
  return map;
}

export async function getLabelsForItems(env, userId, ids) {
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT item_id, label FROM item_tags WHERE user_id=? AND item_id IN (${ph})`,
  )
    .bind(userId, ...ids)
    .all();
  const map = {};
  for (const r of res.results || []) {
    (map[r.item_id] = map[r.item_id] || []).push(r.label);
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
    } else {
      idsLong.push(v);
    }
  }
  const cond = [];
  const args = [];
  if (rowids.length) {
    cond.push(`i.rowid IN (${rowids.map(() => '?').join(',')})`);
    args.push(...rowids);
  }
  if (idsLong.length) {
    cond.push(`i.id IN (${idsLong.map(() => '?').join(',')})`);
    args.push(...idsLong);
  }
  if (!cond.length) return [];
  const res = await env.DB.prepare(
    `SELECT i.rowid, i.*, f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
     FROM items i JOIN feeds f ON f.id = i.feed_id
     WHERE ${cond.join(' OR ')}`,
  )
    .bind(...args)
    .all();
  return res.results || [];
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