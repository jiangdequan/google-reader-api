// Shared minimal D1 fake for the integration tests: records every
// prepare/bind/all/run/first plus the statement order of batch().
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = null;
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() {
    this.db.plan.push({ op: 'all', sql: this.sql, args: this.args });
    return { results: await this.db.onAll(this) };
  }
  async run() {
    this.db.plan.push({ op: 'run', sql: this.sql, args: this.args });
    return await this.db.onRun(this);
  }
  async first() {
    this.db.plan.push({ op: 'first', sql: this.sql, args: this.args });
    return await this.db.onFirst(this);
  }
}

export class FakeDB {
  constructor(opts = {}) {
    this.onAll = opts.onAll || (() => []);
    this.onRun = opts.onRun || (() => ({ meta: { last_row_id: 1 } }));
    this.onFirst = opts.onFirst || (() => null);
    this.plan = [];
    this.batches = [];
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  async batch(stmts) {
    this.batches.push(stmts.map((s) => ({ sql: s.sql, args: s.args })));
    const outs = [];
    for (const s of stmts) {
      outs.push({ results: await this.onAll(s) });
    }
    return outs;
  }
  runs(sqlLike) {
    return this.plan.filter((p) => p.op === 'run' && p.sql.includes(sqlLike));
  }
  queries(sqlLike) {
    return this.plan.filter((p) => p.op === 'all' && p.sql.includes(sqlLike));
  }
}

// Standard item row shape consumed by getItemsStream/streamContents.
export function itemRow(n, over = {}) {
  return {
    rowid: n,
    id: 'tag:google.com,2005:reader/item/' + n.toString(16).padStart(16, '0'),
    guid: 'g' + n,
    url: `https://e.com/${n}`,
    title: `t${n}`,
    author: 'a',
    content: 'c',
    enclosure: '',
    published: 1000 + n,
    timestamp_usec: String((1000 + n) * 1000000),
    crawl_time: 1000 + n,
    feed_url: 'https://f.com/rss',
    feed_title: 'F',
    feed_html: 'https://f.com',
    ...over,
  };
}
