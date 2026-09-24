import { subscribedPredicate } from './util.js';

// Shared WHERE predicates for the unread counts. Each returns { sql, args } so
// callers can AND-combine them and keep every bind parameterized. Mirrors the
// fragment style of db/items.js buildStreamWhere.
const subscribed = (userId) => subscribedPredicate(userId);

const notRead = (userId) => ({
  sql: "NOT EXISTS (SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='read')",
  args: [userId],
});

const starred = (userId) => ({
  sql: "EXISTS (SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='starred')",
  args: [userId],
});

// JOIN scope that ties labels to each item through the user's subscription tags.
const labelScope = (userId) => ({
  sql: `JOIN subscription_tags st ON st.feed_id = i.feed_id AND st.user_id = ?
        JOIN tags t ON t.id = st.tag_id AND t.user_id = ?`,
  args: [userId, userId],
});

const and = (...parts) => ({
  sql: parts.map((p) => p.sql).join(' AND '),
  args: parts.flatMap((p) => p.args),
});

export async function feedUnread(env, userId) {
  const pred = and(subscribed(userId), notRead(userId));
  const res = await env.DB.prepare(
    `SELECT i.feed_id AS feed_id, f.url AS feed_url, COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     JOIN feeds f ON f.id = i.feed_id
     WHERE ${pred.sql}
     GROUP BY i.feed_id, f.url`,
  )
    .bind(...pred.args)
    .all();
  return res.results || [];
}

export async function labelUnread(env, userId) {
  const scope = labelScope(userId);
  const pred = notRead(userId);
  const res = await env.DB.prepare(
    `SELECT t.name AS name, COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     ${scope.sql}
     WHERE ${pred.sql}
     GROUP BY t.name`,
  )
    .bind(...scope.args, ...pred.args)
    .all();
  return res.results || [];
}

export async function readingListUnread(env, userId) {
  const pred = and(subscribed(userId), notRead(userId));
  return await env.DB.prepare(
    `SELECT COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     WHERE ${pred.sql}`,
  )
    .bind(...pred.args)
    .first();
}

export async function starredUnread(env, userId) {
  const pred = and(subscribed(userId), starred(userId), notRead(userId));
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items i
     WHERE ${pred.sql}`,
  )
    .bind(...pred.args)
    .first();
  return r ? r.c : 0;
}
