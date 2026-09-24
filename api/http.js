import { b64urlDecode, b64urlEncode } from '../util.js';
import { resolveStreamIds } from './stream-parser.js';

export async function readForm(request) {
  try {
    return new URLSearchParams(await request.text());
  } catch (e) {
    // GET requests carry no body; an empty form is the expected fallback.
    return new URLSearchParams();
  }
}

export function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Uses `html`/`xml`-style GET params to build the paging/filtering opts that
// getItemsStream/countStreamItems expect. `paging:false` keeps only the
// xt/it filters (all that a COUNT needs); `refsOnly`/`maxLimit` serve the
// stream/items/ids endpoint.
export async function buildStreamOpts(
  url,
  env,
  { refsOnly = false, paging = true, maxLimit = 1000 } = {},
) {
  const [xtResolved, itResolved] = await Promise.all([
    resolveStreamIds(env, url.searchParams.getAll('xt')),
    resolveStreamIds(env, url.searchParams.getAll('it')),
  ]);
  if (!paging) return { xtResolved, itResolved };
  const opts = {
    order: url.searchParams.get('r') || '',
    limit: clampInt(url.searchParams.get('n'), 20, 1, maxLimit),
    offset: contDec(url.searchParams.get('c')),
    cursor: cursorDec(url.searchParams.get('c')),
    xtResolved,
    itResolved,
    ot: url.searchParams.get('ot') ? parseInt(url.searchParams.get('ot'), 10) : null,
    nt: url.searchParams.get('nt') ? parseInt(url.searchParams.get('nt'), 10) : null,
  };
  if (refsOnly) opts.refsOnly = true;
  return opts;
}

export function contDec(c) {
  if (!c) return 0;
  try {
    const s = b64urlDecode(String(c));
    const m = s.match(/^v1\|(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch (e) {
    return 0;
  }
}

export function cursorEnc(order, published, id) {
  return b64urlEncode('v2|' + (order === 'o' ? 'o' : 'd') + '|' + published + '|' + id);
}

export function cursorDec(c) {
  if (!c) return null;
  try {
    const s = b64urlDecode(String(c));
    const m = s.match(/^v2\|(o|d)\|(-?\d+)\|(.+)$/);
    return m ? { order: m[1] === 'o' ? 'o' : '', published: parseInt(m[2], 10), id: m[3] } : null;
  } catch (e) {
    return null;
  }
}

export function iconUrl(origin, url) {
  try {
    const host = new URL(url).host;
    return `${origin}/favicon?host=${encodeURIComponent(host)}`;
  } catch (e) {
    return '';
  }
}