import { json } from '../util.js';
import { feedUnread, labelUnread, readingListUnread, starredUnread } from '../db/unread.js';

export async function unreadCount(request, env, user) {
  const out = { max: 0, unreadcounts: [] };

  const [feedRows, labelRows, rl, starred] = await Promise.all([
    feedUnread(env, user.id),
    labelUnread(env, user.id),
    readingListUnread(env, user.id),
    starredUnread(env, user.id),
  ]);
  for (const r of feedRows) {
    if (!r.c) continue;
    out.unreadcounts.push({
      id: 'feed/' + r.feed_url,
      count: r.c,
      newestItemTimestampUsec: String((r.m || 0) * 1000000),
      updated: r.m,
      twitter: r.m,
      freshness: 1,
    });
  }

  for (const r of labelRows) {
    if (!r.c) continue;
    out.unreadcounts.push({
      id: `user/-/label/${r.name}`,
      count: r.c,
      newestItemTimestampUsec: String((r.m || 0) * 1000000),
      updated: r.m,
      twitter: r.m,
      freshness: 1,
    });
  }

  out.unreadcounts.unshift({
    id: 'user/-/state/com.google/reading-list',
    count: rl ? rl.c : 0,
    newestItemTimestampUsec: String((rl && rl.m ? rl.m : 0) * 1000000),
    updated: rl ? rl.m : 0,
    freshness: 1,
  });
  out.max = rl ? rl.c : 0;

  if (starred > 0) {
    out.unreadcounts.push({
      id: 'user/-/state/com.google/starred',
      count: starred,
      newestItemTimestampUsec: '0',
      freshness: 1,
    });
  }
  return json(out);
}
