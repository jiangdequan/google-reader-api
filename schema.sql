-- Self-hosted Google Reader API (Cloudflare D1) schema.
-- The worker also bootstraps this schema automatically on first request,
-- so running this file manually is optional (useful for `wrangler d1 execute`).

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    html_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    last_fetched INTEGER NOT NULL DEFAULT 0,
    fetch_error TEXT NOT NULL DEFAULT '',
    etag TEXT NOT NULL DEFAULT '',
    updated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER NOT NULL,
    feed_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, feed_id)
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS subscription_tags (
    user_id INTEGER NOT NULL,
    feed_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, feed_id, tag_id)
);

CREATE TABLE IF NOT EXISTS items (
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
);

CREATE TABLE IF NOT EXISTS item_states (
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id, state)
);

CREATE TABLE IF NOT EXISTS item_tags (
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id, label)
);

CREATE INDEX IF NOT EXISTS idx_items_feed_pub ON items(feed_id, published);
CREATE INDEX IF NOT EXISTS idx_items_pub ON items(published);
CREATE INDEX IF NOT EXISTS idx_states ON item_states(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_item_tags ON item_tags(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_subtags ON subscription_tags(user_id, feed_id);