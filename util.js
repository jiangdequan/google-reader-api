const enc = new TextEncoder();
const dec = new TextDecoder();

export function json(data, status = 200) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(enc.encode(body).length),
    },
  });
}

export function text(data, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(String(data), {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': String(enc.encode(String(data)).length),
    },
  });
}

export function xml(data, status = 200, contentType = 'application/atom+xml; charset=utf-8') {
  return new Response(String(data), {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': String(enc.encode(String(data)).length),
    },
  });
}

export function b64urlEncode(str) {
  let bin = '';
  for (const b of enc.encode(str)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return dec.decode(bytes);
}

export function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret || 'greader-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toHex(sig);
}

export async function sha1Hex(data) {
  const digest = await crypto.subtle.digest('SHA-1', enc.encode(data));
  return toHex(digest);
}

export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return toHex(digest);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

export function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).trim());
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function randomHex(bytes = 8) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}