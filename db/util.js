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

export { SQL_CHUNK, BATCH_CHUNK, batchAll };