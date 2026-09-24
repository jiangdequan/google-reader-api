import { now, randomHex, sha256Hex } from '../util.js';

export async function hashPassword(password, salt) {
  // Single-round sha256(salt:password). Self-hosted deployments trade KDF cost
  // factor for CPU/battery simplicity — acceptable for low-value personal
  // account creds; deliberately not bcrypt/argon2 (see code-review P2-1).
  return await sha256Hex(salt + ':' + password);
}

export async function createUser(env, username, password) {
  const salt = randomHex(8);
  const pwh = await hashPassword(password, salt);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO users(username, password_hash, created_at) VALUES (?,?,?)',
  )
    .bind(username, 'sha256:' + salt + ':' + pwh, now())
    .run();
  return await getUserByUsername(env, username);
}

export async function ensureDefaultUsers(env) {
  const raw =
    env.GR_USERS ||
    (env.GR_USERNAME && env.GR_PASSWORD
      ? `${env.GR_USERNAME}:${env.GR_PASSWORD}`
      : '');
  if (!raw) return;
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const u = part.slice(0, idx).trim();
    const p = part.slice(idx + 1);
    if (!u || !p) continue;
    const existing = await env.DB.prepare('SELECT id FROM users WHERE username=?')
      .bind(u)
      .first();
    if (!existing) await createUser(env, u, p);
  }
}

export async function getUserByUsername(env, username) {
  return await env.DB.prepare('SELECT * FROM users WHERE username=?')
    .bind(username)
    .first();
}

export async function getUserById(env, id) {
  return await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
}

export async function verifyPassword(env, username, password) {
  if (!username || password === undefined || password === null) return null;
  const row = await getUserByUsername(env, username);
  if (!row) return null;
  const [scheme, salt, stored] = (row.password_hash || '').split(':');
  if (scheme !== 'sha256' || !salt || !stored) return null;
  const h = await hashPassword(password, salt);
  return h === stored ? row : null;
}