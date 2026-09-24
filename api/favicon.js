import { DEFAULT_FAVICON_TIMEOUT_MS } from '../constants.js';
import { text, timeout } from '../util.js';

const CACHE_TTL = 7 * 86400;

async function fetchIcon(src) {
  const t = timeout(DEFAULT_FAVICON_TIMEOUT_MS);
  try {
    return await fetch(src, { signal: t.signal });
  } finally {
    t.clear();
  }
}

export async function favicon(request, env, url) {
  const host = url.searchParams.get('host') || '';
  if (!host) return text('', 400);
  const cacheKey = new Request('https://favicon-cache/' + host.toLowerCase(), { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch (e) {
    // Cache subsystem hiccup; serve live instead of failing the request.
    console.warn('favicon cache read failed', e && e.message);
  }
  const sources = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
  ];
  for (const src of sources) {
    try {
      const resp = await fetchIcon(src);
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
          console.warn('favicon cache write failed', src, e && e.message);
        }
        return out;
      }
    } catch (e) {
      console.warn('favicon fetch failed', src, e && e.message);
    }
  }
  return text('', 404);
}
