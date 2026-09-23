import { json, text } from '../util.js';
import { disableTag as dbDisableTag, listTags, renameTag as dbRenameTag } from '../db/tags.js';
import { markStreamRead, resolveStreamId } from '../db/items.js';
import { applyTag, readForm, stripLabel } from './utils.js';

export async function tagList(request, env, user) {
  const specials = [
    ['user/-/state/com.google/reading-list', 'A0000001'],
    ['user/-/state/com.google/starred', 'A0000002'],
    ['user/-/state/com.google/broadcast', 'A0000003'],
    ['user/-/state/com.google/kept-unread', 'A0000004'],
  ];
  const tags = specials.map(([id, sortid]) => ({ id, sortid }));
  const labels = await listTags(env, user.id);
  labels.forEach((l, i) => {
    tags.push({ id: `user/-/label/${l.name}`, sortid: 'B' + String(i).padStart(7, '0') });
  });
  return json({ tags });
}

export async function editTag(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const ids = url.searchParams.getAll('i').length
    ? url.searchParams.getAll('i')
    : form.getAll('i');
  const adds = url.searchParams.getAll('a').length
    ? url.searchParams.getAll('a')
    : form.getAll('a');
  const removes = url.searchParams.getAll('r').length
    ? url.searchParams.getAll('r')
    : form.getAll('r');
  for (const id of ids) {
    for (const a of adds) await applyTag(env, user, id, a, true);
    for (const r of removes) await applyTag(env, user, id, r, false);
  }
  return text('OK');
}

export async function markAllAsRead(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const s = form.get('s') || url.searchParams.get('s') || '';
  const tsRaw = form.get('ts') || url.searchParams.get('ts');
  const ts = tsRaw ? parseInt(tsRaw, 10) : null;
  if (!s) return text('OK');
  const stream = await resolveStreamId(env, s);
  if (stream.kind === 'unknown') return text('OK');
  await markStreamRead(env, user.id, stream, ts);
  return text('OK');
}

export async function renameTag(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const s = form.get('s') || form.get('t') || url.searchParams.get('s') || url.searchParams.get('t') || '';
  const dest = form.get('dest') || url.searchParams.get('dest') || '';
  const oldName = stripLabel(s);
  const newName = stripLabel(dest);
  if (!oldName || !newName) return text('OK');
  await dbRenameTag(env, user.id, oldName, newName);
  return text('OK');
}

export async function disableTag(request, env, user) {
  const url = new URL(request.url);
  const form = await readForm(request);
  const s = form.get('s') || form.get('t') || url.searchParams.get('s') || url.searchParams.get('t') || '';
  const name = stripLabel(s);
  if (!name) return text('OK');
  await dbDisableTag(env, user.id, name);
  return text('OK');
}