import { test } from 'node:test';
import assert from 'node:assert/strict';

import { continuationOffsetDec, cursorDec, cursorEnc } from '../api/http.js';
import { stripLabel } from '../api/stream-parser.js';
import { decodeURIComponentSafe } from '../util.js';
import { b64urlEncode } from '../util.js';

test('cursor encode/decode roundtrip preserves order, published and id', () => {
  for (const [order, wantOrder] of [
    ['o', 'o'],
    ['', ''],
  ]) {
    const enc = cursorEnc(order, 1234567, 'tag:item/abc');
    assert.equal(typeof enc, 'string');
    assert.deepEqual(cursorDec(enc), { order: wantOrder, published: 1234567, id: 'tag:item/abc' });
  }
});

test('cursorDec tolerates junk and legacy v1 offsets', () => {
  assert.equal(cursorDec(null), null);
  assert.equal(cursorDec(''), null);
  assert.equal(cursorDec('not-base64!'), null);
  // v2 payloads missing pieces are rejected
  assert.equal(cursorDec(b64urlEncode('v2|o|123')), null);
  // legacy v1 continuations are offsets, not cursors
  assert.equal(continuationOffsetDec(b64urlEncode('v1|42')), 42);
  assert.equal(continuationOffsetDec(b64urlEncode('nonsense')), 0);
  assert.equal(continuationOffsetDec(null), 0);
  assert.equal(continuationOffsetDec(undefined), 0);
});

test('decodeURIComponentSafe leaves malformed percent-encoding untouched', () => {
  assert.equal(decodeURIComponentSafe('hello%20world'), 'hello world');
  assert.equal(decodeURIComponentSafe('bad%zz'), 'bad%zz');
  assert.equal(decodeURIComponentSafe(null), 'null'); // non-strings go through decodeURIComponent's coercion
});

test('stripLabel normalizes the three label spellings plus bare names', () => {
  assert.equal(stripLabel('user/-/label/dev'), 'dev');
  assert.equal(stripLabel('user/123/label/dev'), 'dev');
  assert.equal(stripLabel('user/-/tag/dev'), 'dev');
  assert.equal(stripLabel('user/-/tags/dev'), 'dev');
  assert.equal(stripLabel('dev'), 'dev');
});
