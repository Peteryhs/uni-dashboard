/** A small shared SQLite surface: DO SQL cursors and Node DatabaseSync implement this adapter. */
export class TransitStore {
  constructor(exec, transaction = work => work()) {
    this.exec = exec;
    this.transaction = transaction;
    exec('CREATE TABLE IF NOT EXISTS transit_record (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  get(key) { const row = [...this.exec('SELECT value FROM transit_record WHERE key=?', key)][0]; return row ? JSON.parse(row.value) : null; }
  put(key, value) { this.exec('INSERT INTO transit_record(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  delete(key) { this.exec('DELETE FROM transit_record WHERE key=?', key); }
  prune(prefix) { this.exec('DELETE FROM transit_record WHERE key >= ? AND key < ?', prefix, `${prefix}\uffff`); }
  batch(work) { return this.transaction(work); }
}

export function sqliteTransitTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
