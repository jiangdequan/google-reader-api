import { insertFeed, staleFeeds, updateFetchMeta } from './db/feeds.js';
import { insertNewItems, pruneFeed } from './db/items.js';
import { now } from './util.js';
import { fetchFeed } from './feedfetch.js';

export async function fetchAndStoreFeed(env, feed) {
  const res = await fetchFeed(env, feed);
  if (res.error) {
    if (feed.id) await updateFetchMeta(env, feed.id, { error: res.error });
    return { feedId: feed.id || 0, url: feed.url || '', error: res.error };
  }
  if (res.unchanged) {
    if (feed.id) await updateFetchMeta(env, feed.id, {});
    return { feedId: feed.id || 0, url: feed.url || '', unchanged: true };
  }

  const meta = res.feed;
  const stored = await insertFeed(env, {
    url: meta.finalUrl,
    title: meta.title,
    htmlUrl: meta.htmlUrl,
    description: meta.description,
    etag: meta.etag,
    updated: meta.updated,
  });
  const feedId = stored.id;
  const added = await insertNewItems(env, feedId, meta.finalUrl, res.items);
  const keep = Number(env.MAX_ITEMS_PER_FEED) || 3000;
  await pruneFeed(env, feedId, keep);
  await updateFetchMeta(env, feedId, { etag: meta.etag, updated: meta.updated });
  return { feedId, url: meta.finalUrl, added };
}

export async function runSync(env) {
  const interval = (Number(env.SYNC_INTERVAL_MIN) || 15) * 60;
  const since = now() - interval;
  const limit = Number(env.MAX_FETCH_PER_CRON) || 20;
  const feeds = await staleFeeds(env, since, limit);
  let done = 0;
  for (const f of feeds) {
    try {
      await fetchAndStoreFeed(env, {
        id: f.id,
        url: f.url,
        etag: f.etag || '',
        updated: f.updated || 0,
        title: f.title || '',
      });
      done++;
    } catch (e) {
      console.error('feed sync error', f.url, e);
    }
  }
  return done;
}