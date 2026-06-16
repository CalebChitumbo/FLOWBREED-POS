/**
 * SQLite connection management. The MAIN process holds a single better-sqlite3
 * connection; it is the only place SQLite is touched. No Electron imports here so
 * this module is unit-testable in plain Node.
 */
import Database from 'better-sqlite3';

export type DB = Database.Database;

/** Open a connection and apply the standard PRAGMAs. */
export function openDatabase(filename: string): DB {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

let connection: DB | null = null;

/** Initialise the process-wide singleton connection. */
export function initDatabase(filename: string): DB {
  if (connection) return connection;
  connection = openDatabase(filename);
  return connection;
}

/** Get the singleton connection (throws if not yet initialised). */
export function getDb(): DB {
  if (!connection) throw new Error('Database not initialised — call initDatabase() first');
  return connection;
}

/** Close + clear the singleton (used on shutdown / in tests). */
export function closeDatabase(): void {
  if (connection) {
    connection.close();
    connection = null;
  }
}
