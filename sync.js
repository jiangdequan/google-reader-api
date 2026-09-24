// Feed fetching & ingestion: pull one feed -> store items -> prune stale data ->
// update fetch metadata. Triggered from the scheduled cron (index.js) and the
// /reader/api/0/sync endpoint.
import { DEFAULT_MAX_FETCH_PER_CRON, DEFAULT_MAX_ITEMS_PER_FEED, DEFAULT_SYNC_INTERVAL_MIN } from './constants.js';
import { getFeedByUrl } from './db/feeds.js';
import { insertFeed, staleFeeds, updateFetchMeta } from './db/feeds.js';
import { insertNewItems, pruneFeed } from './db/items.js';
import { now } from './util.js';
import { fetchFeed } from './feedfetch.js';

// Resolve a feed by URL, fetching + storing it when unknown. Returns the stored
// row (or a minimal { id, url } fallback) or null when the fetch failed.
export async function ensureFeed(env, url, title = '') {
  const existing = await getFeedByUrl(env, url);
  if (existing) return existing;
  const res = await fetchAndStoreFeed(env, { url, id: 0, etag: '', updated: 0, title });
  if (res.error || !res.feedId) return null;
  return (await getFeedByUrl(env, res.url)) || { id: res.feedId, url: res.url || url };
}

// Fetch one feed and persist it. Returns { feedId, url, added } on success,
// { error } when fetching/parsing failed, { unchanged } on a 304 response.
export async function fetchAndStoreFeed(env, feed) {
  console.log('fetch feed', feed.url);
  const res = await fetchFeed(env, feed);
  // Fetch failed: record fetch_error for stale/readme diagnostics, stop here.
  if (res.error) {
    console.error('fetch feed error', feed.url, res.error);
    if (feed.id) await updateFetchMeta(env, feed.id, { error: res.error });
    return { feedId: feed.id || 0, url: feed.url || '', error: res.error };
  }
  // 304 Not Modified: only refresh last_fetched; the feed has no new content.
  if (res.unchanged) {
    console.log('feed unchanged', feed.url);
    if (feed.id) await updateFetchMeta(env, feed.id, {});
    return { feedId: feed.id || 0, url: feed.url || '', unchanged: true };
  }

  // New content: upsert the feed metadata (title/etag/updated etc.) to get a
  // stable feedId.
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
  // Insert only new items (deduped by guid, stale entries are skipped) and get
  // the number added this run.
  const added = await insertNewItems(env, feedId, meta.finalUrl, res.items);
  // Prune: keep MAX_ITEMS_PER_FEED (default DEFAULT_MAX_ITEMS_PER_FEED) per feed
  // and clean up orphaned state/tag rows.
  const keep = Number(env.MAX_ITEMS_PER_FEED) || DEFAULT_MAX_ITEMS_PER_FEED;
  await pruneFeed(env, feedId, keep);
  // Record the fetch result so the next request can send a 304 conditional.
  await updateFetchMeta(env, feedId, { etag: meta.etag, updated: meta.updated });
  return { feedId, url: meta.finalUrl, added };
}

// Feeds fetched concurrently per run. Feeds are independent, so concurrency
// mostly hides network latency; too high adds subrequest-quota and connection
// pressure — 5 is a safe, visibly faster choice.
const CONCURRENCY = 5;

// Sync feeds that look stale (not fetched within SYNC_INTERVAL_MIN). Both the
// cron and the manual /sync endpoint enter here; each run processes at most
// MAX_FETCH_PER_CRON feeds to respect the Worker subrequest quota.
export async function runSync(env) {
  console.log('sync start');
  // Staleness interval, minutes, default 15, tunable via env.
  // Feeds fetched longer ago than this are treated as stale this run.
  // Note: the cron trigger interval may not equal SYNC_INTERVAL_MIN exactly;
  // Worker scheduling can delay. The subrequest quota is ~1000/min per Worker
  // instance, so keep the interval above a minute.
  const interval = (Number(env.SYNC_INTERVAL_MIN) || DEFAULT_SYNC_INTERVAL_MIN) * 60;
  // Feed is stale when last fetched before this moment.
  const since = now() - interval;
  // Max feeds fetched per run, default DEFAULT_MAX_FETCH_PER_CRON, env-tunable.
  const limit = Number(env.MAX_FETCH_PER_CRON) || DEFAULT_MAX_FETCH_PER_CRON;

  // staleFeeds picks the `limit` oldest (ascending last_fetched) feeds.
  const feeds = await staleFeeds(env, since, limit);
  let done = 0;

  // Handle one feed; a failure is logged and does not affect the others.
  const handle = async (f) => {
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
      // One feed failing must not stop the batch; log for investigation.
      console.error('feed sync error', f.url, e);
    }
  };

  // Worker pool: up to CONCURRENCY cursors advance in parallel; whoever is done
  // grabs the next unhandled feed.
  const workers = Math.min(CONCURRENCY, feeds.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < feeds.length) {
        const f = feeds[next++];
        await handle(f);
      }
    }),
  );
  console.log(`sync done: ${done}/${feeds.length} feeds processed`);
  return done;
}
