import { text, xml } from '../util.js';
import { buildOpml, parseOpml } from '../opml.js';
import { addSubscription, getSubscriptions, hasSubscription } from '../db/subscriptions.js';
import { ensureFeed } from '../sync.js';

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
      // Request body is raw OPML, not form-encoded; keep it as-is.
      console.warn('opml import: body not form-encoded, using raw', e && e.message);
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
    let feed = await ensureFeed(env, url, f.title || '');
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