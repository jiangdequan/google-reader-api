import { decodeURIComponentSafe } from '../util.js';
import { getFeedById } from '../db/feeds.js';
import { getItemsByIds, resolveStreamId, setItemLabel, setItemState } from '../db/items.js';
import { parseStreamId, serializeStreamId } from '../streamid.js';

// A "label" term is either a canonical user/-/(label|tag|tags)/<name> stream id
// or a bare name; state/feed and other user-prefixed ids are not labels at all.
export function stripLabel(term) {
  const s = String(term || '').trim();
  const p = parseStreamId(s);
  if (p.kind === 'label') return p.name;
  if (p.kind === 'state' || p.userPrefixed) return '';
  return decodeURIComponentSafe(s);
}

function tagObject(term) {
  const s = String(term || '').trim();
  if (!s) return { kind: 'none' };
  const p = parseStreamId(s);
  if (p.kind === 'feed') return { kind: 'none' };
  if (p.kind === 'state') return p.state ? { kind: 'state', state: p.state } : { kind: 'none' };
  if (p.kind === 'label') return p.name ? { kind: 'label', name: p.name } : { kind: 'none' };
  if (p.feedPrefixed || p.userPrefixed) return { kind: 'none' };
  return { kind: 'label', name: decodeURIComponentSafe(s) };
}

export const canonicalStreamId = serializeStreamId;

export async function applyTag(env, user, itemId, term, on) {
  const t = tagObject(term);
  const uid = user.id;
  const rows = await getItemsByIds(env, [itemId]);
  const id = rows.length ? rows[0].id : itemId;
  if (t.kind === 'state') {
    const st = t.state;
    if (st === 'read') {
      await setItemState(env, uid, id, 'read', on);
      if (on) await setItemState(env, uid, id, 'kept-unread', false);
    } else if (st === 'unread') {
      await setItemState(env, uid, id, 'read', !on);
    } else if (st === 'kept-unread') {
      if (on) {
        await setItemState(env, uid, id, 'read', false);
        await setItemState(env, uid, id, 'kept-unread', true);
      } else {
        await setItemState(env, uid, id, 'kept-unread', false);
      }
    } else if (st === 'starred') {
      await setItemState(env, uid, id, 'starred', on);
    } else if (st === 'broadcast') {
      await setItemState(env, uid, id, 'broadcast', on);
    }
    // com.google/tracking-* ignored
  } else if (t.kind === 'label') {
    await setItemLabel(env, uid, id, t.name, on);
  }
}

// Resolves a list of xt/it exclusion/inclusion terms, dropping unknowns.
export async function resolveStreamIds(env, terms) {
  const results = await Promise.all(
    (terms || []).map(async (term) => {
      const s = String(term).trim();
      const target = await resolveStreamId(env, s);
      return target.kind !== 'unknown' ? target : null;
    }),
  );
  return results.filter(Boolean);
}

export async function streamTitle(env, stream, username) {
  if (stream.kind === 'feed') {
    if (stream.feedId) {
      const f = await getFeedById(env, stream.feedId);
      if (f && f.title) return f.title;
    }
    return stream.url;
  }
  if (stream.kind === 'label') return `${stream.name} streaming list`;
  switch (stream.state) {
    case 'starred':
      return 'Starred items';
    case 'broadcast':
      return 'Shared items';
    case 'kept-unread':
      return 'Kept-unread items';
    case 'read':
      return 'Read items';
    case 'fresh':
      return 'Fresh items';
    default:
      return `${username}'s reading list`;
  }
}
