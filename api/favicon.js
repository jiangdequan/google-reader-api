import { text } from '../util.js';

async function fetchTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const CACHE_TTL = 7 * 86400;

export async function favicon(request, env, url) {
  const host = url.searchParams.get('host') || '';
  if (!host) return text('', 400);
  const cacheKey = new Request('https://favicon-cache/' + host.toLowerCase(), { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch (e) {
    /* ignore */
  }
  const sources = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
  ];
  for (const src of sources) {
    try {
      const resp = await fetchTimeout(src);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        const out = new Response(buf, {
          headers: {
            'Content-Type': resp.headers.get('content-type') || 'image/x-icon',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        });
        try {
          await caches.default.put(cacheKey, out.clone());
        } catch (e) {
          /* ignore */
        }
        return out;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return text('', 404);
}