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