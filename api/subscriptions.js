import { json, text } from '../util.js';
import {
  addSubscription,
  getSubscriptions,
  hasSubscription,
  latestTimestamps,
  removeSubscription,
  updateSubscriptionTitle,
} from '../db/subscriptions.js';
import { detachLabel } from '../db/tags.js';
import { getFeedById, getFeedByUrl } from '../db/feeds.js';
import { ensureFeed } from '../sync.js';
import { iconUrl, readForm } from './http.js';
import { stripLabel } from './stream-parser.js';

export async function subscriptionList(request, env, user) {
  const url = new URL(request.url);
  const origin = url.origin;
  const subs = await getSubscriptions(env, user.id);
  const latest = await latestTimestamps(
    env,
    subs.map((s) => s.feed_id),
  );
  const sorted = subs
    .slice()
    .sort((a, b) =>
      (a.custom_title || a.feed_title || a.feed_url).localeCompare(b.custom_title || b.feed_title || b.feed_url),
    );
  return json({
    subscriptions: sorted.map((s, i) => {
      const title = s.custom_title || s.feed_title || s.feed_url;
      return {
        id: 'feed/' + s.feed_url,
        title,
        categories: (s.labels || []).map((l) => ({
          id: `user/-/label/${l}`,
          label: l,
        })),
        sortid: 'A' + String(i).padStart(7, '0'),
        firstitemmsec: String(latest[s.feed_id] || 0),
        htmlUrl: s.feed_html || s.feed_url || '',
        iconUrl: iconUrl(origin, s.feed_url),
        url: s.feed_url,
        origin: {
          streamId: 'feed/' + s.feed_url,
          title,
          htmlUrl: s.feed_html || s.feed_url || '',
          url: s.feed_url,
        },
      };
    }),
  });
}

export async function subscriptionQuickadd(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  let q = form.get('quickadd') || url.searchParams.get('quickadd') || '';
  if (q.startsWith('feed/http')) q = q.slice(5);
  if (!q) return json({ numResults: 0, query: q, streamId: '' });
  try {
    q = new URL(q).href;
  } catch (e) {
    return json({ numResults: 0, query: q, streamId: '' });
  }
  const feed = await ensureFeed(env, q);
  if (!feed || !feed.id) return json({ numResults: 0, query: q, streamId: '' });
  if (!(await hasSubscription(env, user.id, feed.id))) {
    await addSubscription(env, user.id, feed.id, '', []);
  }
  return json({
    numResults: 1,
    query: feed.url || q,
    streamId: 'feed/' + (feed.url || q),
    feedId: '',
    interrupted: false,
  });
}

export async function subscriptionEdit(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const pick = (name) => form.get(name) || url.searchParams.get(name);
  const pickAll = (...names) => names.flatMap((name) => [...form.getAll(name), ...url.searchParams.getAll(name)]);
  const ac = pick('ac') || 'subscribe';
  let s = pick('s') || pick('url') || '';
  if (s.startsWith('feed/')) s = s.slice(5);
  const t = pick('t') || '';
  const labelsToAdd = [...new Set(pickAll('add', 'a').map(stripLabel).filter(Boolean))];
  const labelsToRemove = [...new Set(pickAll('r', 'remove').map(stripLabel).filter(Boolean))];
  const lookupFeed = (ref) => (/^\d+$/.test(ref) ? getFeedById(env, Number(ref)) : getFeedByUrl(env, ref));

  if (ac === 'unsubscribe' || ac === 'remove' || ac === 'unsub' || ac === 'delete') {
    const feed = await lookupFeed(s);
    if (feed) await removeSubscription(env, user.id, feed.id);
    return text('OK');
  }
  if (!s) return text('OK');

  let feed = await lookupFeed(s);
  if (!feed) feed = await ensureFeed(env, s, t);
  if (!feed) return text('OK');

  const existing = await hasSubscription(env, user.id, feed.id);
  if (!existing) {
    await addSubscription(env, user.id, feed.id, t, labelsToAdd);
  } else {
    if (t) await updateSubscriptionTitle(env, user.id, feed.id, t);
    for (const l of labelsToAdd) await addSubscription(env, user.id, feed.id, '', [l]);
  }
  for (const l of labelsToRemove) await detachLabel(env, user.id, feed.id, l);
  return text('OK');
}
