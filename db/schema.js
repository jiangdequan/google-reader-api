import { SQL_CHUNK } from './util.js';

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
  await normalizeStateKeys(env);
  schemaReady.set(env, true);
}

async function normalizeStateKeys(env) {
  const res = await env.DB.prepare(
    "SELECT DISTINCT item_id FROM (SELECT item_id FROM item_states UNION SELECT item_id FROM item_tags) WHERE item_id NOT LIKE 'tag:%'",
  ).all();
  const keys = (res.results || []).map((r) => r.item_id);
  if (!keys.length) return;
  const byRowid = new Map();
  for (const k of keys) {
    const s = String(k).trim();
    let n = NaN;
    if (s.length === 16 && /^[0-9a-fA-F]{16}$/.test(s)) {
      n = parseInt(s, 16);
    } else if (/^[0-9a-fA-F]{1,7}$/.test(s)) {
      n = /^\d+$/.test(s) ? parseInt(s, 10) : parseInt(s, 16);
    }
    if (Number.isSafeInteger(n) && n > 0) byRowid.set(n, s);
  }
  const rowids = [...byRowid.keys()];
  for (let i = 0; i < rowids.length; i += SQL_CHUNK) {
    const chunk = rowids.slice(i, i + SQL_CHUNK);
    const found = await env.DB.prepare(
      `SELECT rowid, id FROM items WHERE rowid IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(...chunk)
      .all();
    const stmts = [];
    for (const row of found.results || []) {
      const legacy = byRowid.get(row.rowid);
      if (!legacy || String(row.id) === String(legacy)) continue;
      stmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO item_states(user_id, item_id, state) SELECT user_id, ?, state FROM item_states WHERE item_id = ?',
        ).bind(row.id, legacy),
      );
      stmts.push(env.DB.prepare('DELETE FROM item_states WHERE item_id = ?').bind(legacy));
      stmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO item_tags(user_id, item_id, label) SELECT user_id, ?, label FROM item_tags WHERE item_id = ?',
        ).bind(row.id, legacy),
      );
      stmts.push(env.DB.prepare('DELETE FROM item_tags WHERE item_id = ?').bind(legacy));
    }
    for (let j = 0; j < stmts.length; j += 80) {
      await env.DB.batch(stmts.slice(j, j + 80));
    }
  }
}