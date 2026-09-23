export async function feedUnread(env, userId) {
  const res = await env.DB.prepare(
    `SELECT i.feed_id AS feed_id, f.url AS feed_url, COUNT(*) AS c, MAX(i.published) AS m
     FROM items i
     JOIN feeds f ON f.id = i.feed_id
     WHERE EXISTS (
       SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='read'
     )
     GROUP BY i.feed_id, f.url`,
  )
    .bind(userId, userId)
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
     WHERE EXISTS (
       SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='read'
     )`,
  )
    .bind(userId, userId)
    .first();
}

export async function starredUnread(env, userId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items i
     WHERE EXISTS (
       SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id
     )
     AND EXISTS (SELECT 1 FROM item_states s WHERE s.user_id=? AND s.item_id=i.id AND s.state='starred')
     AND NOT EXISTS (SELECT 1 FROM item_states s2 WHERE s2.user_id=? AND s2.item_id=i.id AND s2.state='read')`,
  )
    .bind(userId, userId, userId)
    .first();
  return r ? r.c : 0;
}