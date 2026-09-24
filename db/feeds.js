import { now } from '../util.js';

export async function getFeedByUrl(env, url) {
  return await env.DB.prepare('SELECT * FROM feeds WHERE url=?').bind(url).first();
}

export async function getFeedById(env, id) {
  return await env.DB.prepare('SELECT * FROM feeds WHERE id=?').bind(id).first();
}

export async function insertFeed(env, meta) {
  const existing = await getFeedByUrl(env, meta.url);
  if (existing) {
    await env.DB.prepare('UPDATE feeds SET title=?, html_url=?, description=?, etag=?, updated=? WHERE id=?')
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
  await env.DB.prepare('UPDATE feeds SET last_fetched=?, fetch_error=?, etag=?, updated=? WHERE id=?')
    .bind(now(), error || '', etag || '', updated || 0, feedId)
    .run();
}

export async function staleFeeds(env, since, limit) {
  const res = await env.DB.prepare('SELECT * FROM feeds WHERE last_fetched < ? ORDER BY last_fetched ASC LIMIT ?')
    .bind(since, limit)
    .all();
  return res.results || [];
}
