/**
 * Forward-only migration runner keyed on `PRAGMA user_version`.
 * Each migration runs inside a transaction; the version bumps only if it succeeds.
 * Runs on MAIN startup before any service is available. Unit-testable in Node.
 */
import type { DB } from './connection';
import init001 from './migrations/001_init.sql?raw';
import financialHub002 from './migrations/002_financial_hub.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered list of migrations. Append new ones; never edit shipped ones. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001_init', sql: init001 },
  { version: 2, name: '002_financial_hub', sql: financialHub002 },
];

export function getSchemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Apply all migrations with a version higher than the DB's current user_version.
 * Returns the resulting schema version.
 */
export function runMigrations(db: DB, migrations: Migration[] = MIGRATIONS): number {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    const current = getSchemaVersion(db);
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // user_version only accepts a literal; migration.version is a trusted integer.
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
  return getSchemaVersion(db);
}
