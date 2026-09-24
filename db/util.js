const SQL_CHUNK = 90; // keep IN (...) well under bind-variable limits (local miniflare ≈100, prod D1 999)
const BATCH_CHUNK = 90; // D1 batch caps at 1000 statements; stay well under it per round trip

// Send many prepared statements in a few single round trips to D1,
// returning all D1Result objects flattened in statement order.
async function batchAll(env, stmts) {
  const out = [];
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    out.push(...(await env.DB.batch(stmts.slice(i, i + BATCH_CHUNK))));
  }
  return out;
}

// Shared WHERE predicate: the item's feed is subscribed to by `userId`. Used by
// db/unread.js (unread counts) and db/items.js (reading-list stream), keeping
// the duplicated "subscription EXISTS" text in a single place.
export const subscribedPredicate = (userId) => ({
  sql: 'EXISTS (SELECT 1 FROM subscriptions su WHERE su.user_id=? AND su.feed_id=i.feed_id)',
  args: [userId],
});

// Prepare one statement per SQL_CHUNK-sized slice of `values` via `build(chunk,
// placeholders)`, batch-run them all, and flatten every result row in statement
// order. The one shape shared by the chunked `x IN (?,...)` lookups.
export async function rowsForIn(env, build, values) {
  const stmts = [];
  for (let i = 0; i < values.length; i += SQL_CHUNK) {
    const chunk = values.slice(i, i + SQL_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    stmts.push(build(chunk, ph));
  }
  const rows = [];
  for (const res of await batchAll(env, stmts)) {
    rows.push(...(res.results || []));
  }
  return rows;
}

export { SQL_CHUNK, BATCH_CHUNK, batchAll };
