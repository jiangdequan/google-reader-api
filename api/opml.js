import { text, xml } from '../util.js';
import { buildOpml, parseOpml } from '../opml.js';
import { addSubscription, getSubscriptions, hasSubscription } from '../db/subscriptions.js';
import { getFeedByUrl } from '../db/feeds.js';
import { fetchAndStoreFeed } from '../sync.js';

export async function exportOpml(request, env, user) {
  const subs = await getSubscriptions(env, user.id);
  const labelMap = new Map();
  const unlabeled = [];
  for (const s of subs) {
    const entry = {
      title: s.custom_title || s.feed_title || s.feed_url,
      xmlUrl: s.feed_url,
      htmlUrl: s.feed_html || '',
    };
    const ls = s.labels || [];
    if (ls.length) {
      for (const l of ls) {
        if (!labelMap.has(l)) labelMap.set(l, []);
        labelMap.get(l).push(entry);
      }
    } else {
      unlabeled.push(entry);
    }
  }
  const groups = [];
  if (unlabeled.length) groups.push({ name: null, feeds: unlabeled });
  for (const [name, feeds] of labelMap) groups.push({ name, feeds });
  return xml(buildOpml(`${user.username}'s subscriptions`, groups), 200, 'text/xml; charset=utf-8');
}

export async function importOpml(request, env, user) {
  const raw = await request.text();
  let xmlStr = raw;
  if (!/^\s*<(opml|xml)/i.test(raw)) {
    try {
      const form = new URLSearchParams(raw);
      xmlStr = form.get('file') || form.get('opml') || raw;
    } catch (e) {
      /* keep raw */
    }
  }
  const feeds = parseOpml(xmlStr);
  let added = 0;
  for (const f of feeds) {
    let url = f.xmlUrl.replace(/^feed:\/\//i, 'https://');
    try {
      url = new URL(url).href;
    } catch (e) {
      continue;
    }
    let feed = await getFeedByUrl(env, url);
    if (!feed) {
      const res = await fetchAndStoreFeed(env, { url, id: 0, etag: '', updated: 0, title: f.title || '' });
      if (res.error || !res.feedId) continue;
      feed = await getFeedByUrl(env, res.url);
    }
    if (!feed) continue;
    if (!(await hasSubscription(env, user.id, feed.id))) {
      await addSubscription(env, user.id, feed.id, '', f.group ? [f.group] : []);
      added++;
    } else if (f.group) {
      await addSubscription(env, user.id, feed.id, '', [f.group]);
    }
  }
  return text(`OK added=${added}`);
}