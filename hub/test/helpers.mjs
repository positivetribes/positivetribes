import { DatabaseSync } from 'node:sqlite';
// SQLite-backed D1 adapter: execute the Worker's real SQL, including batch rollback.
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    prepare(sql) {
      let values = [];
      return {
        // D1 takes an ArrayBuffer for a BLOB; node:sqlite wants a typed array.
        bind(...args) { values = args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v); return this; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async first() { return sqlite.prepare(sql).get(...values); },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { last_row_id: Number(result.lastInsertRowid) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { sqlite, db };
}
