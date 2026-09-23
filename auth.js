import { getUserById, verifyPassword } from './db/users.js';
import { b64urlEncode, b64urlDecode, hmacHex, text } from './util.js';

const TOKEN_TTL = 30 * 24 * 3600;

export async function issueToken(env, userId) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const payload = `${userId}:${exp}`;
  const sig = await hmacHex(env.JWT_SECRET || 'greader-secret', payload);
  return b64urlEncode(payload) + '.' + b64urlEncode(sig);
}

export async function parseToken(env, token) {
  try {
    const [p, s] = String(token || '').split('.');
    if (!p || !s) return null;
    const payload = b64urlDecode(p);
    const [userId, expStr] = payload.split(':');
    if (!userId || !expStr || Number(expStr) < Math.floor(Date.now() / 1000)) return null;
    const expected = await hmacHex(env.JWT_SECRET || 'greader-secret', payload);
    if (expected !== b64urlDecode(s)) return null;
    return userId;
  } catch (e) {
    return null;
  }
}

export async function authenticateRequest(request, env, url) {
  const auth = request.headers.get('Authorization') || '';

  if (auth.startsWith('GoogleLogin ')) {
    const m = auth.match(/auth=([^\s,]+)/);
    if (m) {
      const uid = await parseToken(env, m[1]);
      if (uid) return await getUserById(env, Number(uid));
    }
  } else if (auth.startsWith('Bearer ')) {
    const uid = await parseToken(env, auth.slice(7).trim());
    if (uid) return await getUserById(env, Number(uid));
  } else if (auth.startsWith('Basic ')) {
    try {
      const raw = atob(auth.slice(6).trim());
      const idx = raw.indexOf(':');
      if (idx === -1) return null;
      const u = raw.slice(0, idx);
      const p = raw.slice(idx + 1);
      return await verifyPassword(env, u, p);
    } catch (e) {
      return null;
    }
  }

  const token =
    url.searchParams.get('auth') ||
    url.searchParams.get('Token') ||
    url.searchParams.get('token') ||
    url.searchParams.get('T');
  if (token) {
    const uid = await parseToken(env, token);
    if (uid) return await getUserById(env, Number(uid));
  }

  const loginParam =
    url.searchParams.get('login') || url.searchParams.get('Email') || url.searchParams.get('u');
  const passParam =
    url.searchParams.get('password') || url.searchParams.get('Passwd') || url.searchParams.get('pw');
  if (loginParam && passParam !== null) {
    return await verifyPassword(env, loginParam, passParam);
  }
  return null;
}

export async function clientLogin(request, env, url) {
  const method = request.method.toUpperCase();
  let form = null;
  if (method === 'POST') {
    try {
      form = new URLSearchParams(await request.text());
    } catch (e) {
      form = null;
    }
  }
  const Email = url.searchParams.get('Email') || (form && form.get('Email')) || '';
  const Passwd =
    url.searchParams.get('Passwd') || (form && form.get('Passwd')) || '';
  const user = await verifyPassword(env, Email, Passwd);
  if (!user) return text('Error=BadAuthentication\n', 403);
  const auth = await issueToken(env, user.id);
  return text(`SID=${auth}\nLSID=${auth}\nAuth=${auth}\n`);
}