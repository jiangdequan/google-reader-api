// Pure stream-token parsing shared by db (resolveStreamId) and api
// (label/state normalization, canonical id rendering). Single source of
// truth for the Reader stream-id grammar.
import { decodeURIComponentSafe } from './util.js';

export const STATE_PREFIX = 'user/-/state/com.google/';

// Classify + normalize a raw stream token:
//   feed/<number>                -> { kind: 'feed', feedId }
//   feed/http(s)://<url>         -> { kind: 'feed', url }
//   user/<any>/state/...         -> { kind: 'state', state }  (any user id -> '-')
//   user/<any>/(label|tag|tags)  -> { kind: 'label', name }
//   otherwise                    -> { kind: 'unknown', userPrefixed?, feedPrefixed? }
export function parseStreamId(token) {
  let s = String(token || '').trim();
  s = s.replace(/^feed\/(http[s]?):\/([^/])/, '$1://$2');
  s = s.replace(/^user\/[^/]+\//, 'user/-/');

  const feedNum = s.match(/^feed\/(\d+)$/);
  if (feedNum) return { kind: 'feed', feedId: Number(feedNum[1]) };
  if (s.startsWith('feed/http')) return { kind: 'feed', url: s.slice(5) };

  if (s.startsWith(STATE_PREFIX)) {
    return { kind: 'state', state: s.slice(STATE_PREFIX.length) };
  }
  for (const p of ['label', 'tag', 'tags']) {
    const prefix = `user/-/${p}/`;
    if (s.startsWith(prefix)) {
      return { kind: 'label', name: decodeURIComponentSafe(s.slice(prefix.length)) };
    }
  }
  return { kind: 'unknown', userPrefixed: s.startsWith('user/'), feedPrefixed: s.startsWith('feed/') };
}

// Inverse of parseStreamId: render a parsed descriptor back to wire form.
export function serializeStreamId(stream) {
  if (stream.kind === 'feed') return 'feed/' + stream.url;
  if (stream.kind === 'label') return `user/-/label/${stream.name}`;
  return STATE_PREFIX + stream.state;
}
