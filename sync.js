// 订阅源的抓取与入库:拉取单个 feed -> 落库 items -> 裁剪旧数据 -> 更新抓取元信息。
// 由两处触发:scheduled cron(index.js)以及 /reader/api/0/sync 手动触发。
import { DEFAULT_MAX_FETCH_PER_CRON, DEFAULT_MAX_ITEMS_PER_FEED, DEFAULT_SYNC_INTERVAL_MIN } from './constants.js';
import { insertFeed, staleFeeds, updateFetchMeta } from './db/feeds.js';
import { insertNewItems, pruneFeed } from './db/items.js';
import { now } from './util.js';
import { fetchFeed } from './feedfetch.js';

// 抓取单个 feed 并写入存储。返回 { feedId, url, added } 表示正常入库,
// { error } 表示抓取/解析失败, { unchanged } 表示服务端 304 无更新。
export async function fetchAndStoreFeed(env, feed) {
  console.log('fetch feed', feed.url);
  const res = await fetchFeed(env, feed);
  // 抓取失败:记录 fetch_error,方便 readme/stale 判断,不再继续。
  if (res.error) {
    console.error('fetch feed error', feed.url, res.error);
    if (feed.id) await updateFetchMeta(env, feed.id, { error: res.error });
    return { feedId: feed.id || 0, url: feed.url || '', error: res.error };
  }
  // 304 Not Modified:仅刷新 last_fetched,说明 feed 无新内容。
  if (res.unchanged) {
    console.log('feed unchanged', feed.url);
    if (feed.id) await updateFetchMeta(env, feed.id, {});
    return { feedId: feed.id || 0, url: feed.url || '', unchanged: true };
  }

  // 有新内容:upsert feed 元信息(标题/etag/updated 等),得到稳定的 feedId。
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
  // 只插入新增条目(按 guid 去重、可跳过过期条目),返回本次新增条数。
  const added = await insertNewItems(env, feedId, meta.finalUrl, res.items);
  // 裁剪:把该 feed 保留到 MAX_ITEMS_PER_FEED(默认 DEFAULT_MAX_ITEMS_PER_FEED)条,同时清理孤儿 state/tag。
  const keep = Number(env.MAX_ITEMS_PER_FEED) || DEFAULT_MAX_ITEMS_PER_FEED;
  await pruneFeed(env, feedId, keep);
  // 记录抓取结果,供下一次 304 条件请求使用。
  await updateFetchMeta(env, feedId, { etag: meta.etag, updated: meta.updated });
  return { feedId, url: meta.finalUrl, added };
}

// 单次并发抓取的 feed 数。feed 之间相互独立,并发主要省"等网络"的时间;
// 设得过高会叠加 subrequest 配额与连接压力,5 是安全且提速明显的值。
const CONCURRENCY = 5;

// 同步过期(超过 SYNC_INTERVAL_MIN 未抓取)的 feed。cron 与手动 sync 均入口在此,
// 单次最多处理 MAX_FETCH_PER_CRON 条,以控制 Worker 的 subrequest 配额。
export async function runSync(env) {
  console.log('sync start');
  // 过期时间间隔,单位:分钟,默认 15 分钟,可通过环境变量调整。
  // 超过此时间未抓取的 feed 会被视为 stale,在本次 sync 中被抓取。
  // 注意:cron 的触发间隔不一定严格等于 SYNC_INTERVAL_MIN,Worker 调度可能有延迟。
  // Worker 的 subrequest 配额是每个 Worker 实例每分钟 1000 个,所以不要设得太频繁。
  const interval = (Number(env.SYNC_INTERVAL_MIN) || DEFAULT_SYNC_INTERVAL_MIN) * 60;
  // 在此时间之前最后抓取过的 feed 视为过期
  const since = now() - interval;
  // 单次最多抓取的 feed 数量,默认 DEFAULT_MAX_FETCH_PER_CRON,可通过环境变量调整。
  const limit = Number(env.MAX_FETCH_PER_CRON) || DEFAULT_MAX_FETCH_PER_CRON;

  // staleFeeds 按 last_fetched 升序取最"旧"的 limit 个。
  const feeds = await staleFeeds(env, since, limit);
  let done = 0;

  // 依次处理单个 feed:失败只记录,不影响其他 feed。
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
      // 单个 feed 失败不影响批次继续;记录以便排查。
      console.error('feed sync error', f.url, e);
    }
  };

  // 工作池:最多 CONCURRENCY 个"游标"同时推进,谁完成谁取下一个未处理的 feed。
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