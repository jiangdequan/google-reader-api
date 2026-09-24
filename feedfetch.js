import { DEFAULT_FETCH_TIMEOUT_MS, MAX_FETCH_BODY_BYTES } from './constants.js';
import { parseFeed } from './feedparser.js';
import { timeout } from './util.js';

const UA = 'Mozilla/5.0 (compatible; SelfHostedGoogleReader/1.0; +https://github.com/awesome-workers)';
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html, */*;q=0.1';

function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^feed:\/\//i.test(s)) s = 'https://' + s.slice(7);
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.href.replace(/\/+$/, '');
  } catch (e) {
    return null;
  }
}

function discoverFeedLink(html, base) {
  const re = /<link[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const typeMatch = tag.match(/type\s*=\s*["'](application\/(?:rss|atom)\+xml)["']/i);
    if (typeMatch) {
      const hrefMatch = tag.match(/\shref\s*=\s*["']([^"']+)["']/i);
      if (hrefMatch) {
        try {
          return new URL(hrefMatch[1], base).href;
        } catch (e) {
          // Malformed candidate feed link; skip this <link> tag.
          console.warn('discarding malformed feed href', hrefMatch[1], e && e.message);
        }
      }
    }
  }
  return null;
}

// A feed HTML page usually advertises its feed via a <link rel="alternate">;
// when the first request returns HTML, follow that candidate once. Returns
// { parsed, finalUrl } or null (no usable feed link / fetch failed).
async function fetchDiscoveredFeed(html, url, finalUrl) {
  const discovered = discoverFeedLink(html, finalUrl);
  if (!discovered || discovered === url) return null;
  let timer;
  try {
    const t = timeout(DEFAULT_FETCH_TIMEOUT_MS);
    timer = t;
    const resp = await fetch(discovered, {
      headers: { 'User-Agent': UA, Accept: ACCEPT },
      redirect: 'follow',
      signal: t.signal,
    });
    if (!resp.ok) return null;
    const body = await resp.text();
    const parsed = parseFeed(body, resp.headers.get('content-type') || '');
    return parsed ? { parsed, finalUrl: discovered } : null;
  } catch (e) {
    console.error('fetch discovered feed error', discovered, e);
    return null;
  } finally {
    if (timer) timer.clear();
  }
}

export async function fetchFeed(env, feed) {
  const url = normalizeUrl(feed.url);
  if (!url) return { error: 'bad url' };

  const headers = { 'User-Agent': UA, Accept: ACCEPT };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.updated) headers['If-Modified-Since'] = new Date(feed.updated * 1000).toUTCString();

  let timer;
  let resp;
  try {
    const t = timeout(DEFAULT_FETCH_TIMEOUT_MS);
    timer = t;
    resp = await fetch(url, { headers, redirect: 'follow', signal: t.signal });
  } catch (e) {
    console.error('fetch feed error', url, e);
    return { error: String((e && e.message) || e) };
  } finally {
    if (timer) timer.clear();
  }

  if (resp.status === 304) return { unchanged: true };
  if (!resp.ok) return { error: 'HTTP ' + resp.status };

  let body = await resp.text();
  if (body.length > MAX_FETCH_BODY_BYTES) body = body.slice(0, MAX_FETCH_BODY_BYTES);
  let ctype = (resp.headers.get('content-type') || '').toLowerCase();
  let finalUrl = resp.url || url;
  const etag = resp.headers.get('etag') || '';
  const lm = resp.headers.get('last-modified') || '';
  const updated = lm ? Math.max(0, Math.floor(Date.parse(lm) / 1000)) : 0;

  let parsed = parseFeed(body, ctype);

  if (!parsed && (ctype.includes('html') || /<html[\s>]/i.test(body))) {
    const found = await fetchDiscoveredFeed(body, url, finalUrl);
    if (found) {
      parsed = found.parsed;
      finalUrl = found.finalUrl;
    }
  }

  if (!parsed) return { error: 'not a feed' };

  console.log('fetch feed ok', finalUrl, parsed.items.length, 'items');
  return {
    feed: {
      url,
      finalUrl,
      title: parsed.title,
      htmlUrl: parsed.htmlUrl,
      description: parsed.description,
      etag,
      updated,
      contentType: ctype,
    },
    items: parsed.items,
  };
}
