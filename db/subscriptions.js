import { attachLabel } from './tags.js';
import { rowsForIn } from './util.js';

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

export async function getSubscriptions(env, userId) {
  const [subsRes, labelsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT s.user_id, s.feed_id, s.title AS custom_title,
              f.url AS feed_url, f.title AS feed_title, f.html_url AS feed_html
       FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
       WHERE s.user_id = ?
       ORDER BY (CASE WHEN s.title='' THEN f.title ELSE s.title END) ASC`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT st.feed_id AS feed_id, t.name AS name
       FROM subscription_tags st JOIN tags t ON t.id = st.tag_id
       WHERE st.user_id = ?
       ORDER BY t.name ASC`,
    )
      .bind(userId)
      .all(),
  ]);
  const labelMap = new Map();
  for (const l of labelsRes.results || []) {
    if (!labelMap.has(l.feed_id)) labelMap.set(l.feed_id, []);
    labelMap.get(l.feed_id).push(l.name);
  }
  const out = [];
  for (const s of subsRes.results || []) {
    out.push({ ...s, labels: labelMap.get(s.feed_id) || [] });
  }
  return out;
}

export async function latestTimestamps(env, feedIds) {
  const map = {};
  const rows = await rowsForIn(
    env,
    (chunk, ph) =>
      env.DB.prepare(
        `SELECT feed_id, MAX(published)*1000 AS m FROM items WHERE feed_id IN (${ph}) GROUP BY feed_id`,
      ).bind(...chunk),
    [...new Set(feedIds)],
  );
  for (const r of rows) map[r.feed_id] = r.m;
  return map;
}