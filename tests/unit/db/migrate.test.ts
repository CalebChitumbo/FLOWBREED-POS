import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type DB } from '../../../src/main/db/connection';
import { runMigrations, getSchemaVersion } from '../../../src/main/db/migrate';

function freshDb(): DB {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

let db: DB | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

const EXPECTED_TABLES = [
  'users',
  'branches',
  'products',
  'barcodes',
  'inventory',
  'till_sessions',
  'transactions',
  'transaction_items',
  'stock_movements',
  'price_history',
  'audit_log',
  'sync_queue',
  'app_config',
  'finhub_applied_movements',
];

describe('migrations', () => {
  it('applies all migrations and sets the schema version', () => {
    db = openDatabase(':memory:');
    const version = runMigrations(db);
    expect(version).toBe(2);
    expect(getSchemaVersion(db)).toBe(2);
  });

  it('creates every expected table', () => {
    db = freshDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const table of EXPECTED_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('creates the unique barcode index (the scan hot path)', () => {
    db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_barcodes_barcode'")
      .get();
    expect(idx).toBeTruthy();
  });

  it('is idempotent — re-running does not error or change version', () => {
    db = freshDb();
    expect(runMigrations(db)).toBe(2);
    expect(runMigrations(db)).toBe(2);
  });

  it('002 adds the financial link column and unique index', () => {
    db = freshDb();
    const cols = db.prepare('PRAGMA table_info(products)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('financial_id');
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_products_financial_id'")
      .get();
    expect(idx).toBeTruthy();
  });

  it('enforces foreign keys', () => {
    db = freshDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('append-only ledgers (NS-04)', () => {
  function insertAudit(d: DB): void {
    d.prepare(
      `INSERT INTO audit_log (id, user_id, action, datetime) VALUES (?, ?, ?, ?)`,
    ).run('a1', 'u1', 'login', new Date().toISOString());
  }

  it('allows inserts into audit_log', () => {
    db = freshDb();
    expect(() => insertAudit(db!)).not.toThrow();
    const count = (db.prepare('SELECT count(*) AS c FROM audit_log').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('blocks UPDATE on audit_log', () => {
    db = freshDb();
    insertAudit(db);
    expect(() => db!.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = 'a1'").run()).toThrow(
      /append-only/,
    );
  });

  it('blocks DELETE on audit_log', () => {
    db = freshDb();
    insertAudit(db);
    expect(() => db!.prepare("DELETE FROM audit_log WHERE id = 'a1'").run()).toThrow(/append-only/);
  });

  it('blocks UPDATE/DELETE on price_history', () => {
    db = freshDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO products (id, name, category, unit_price, unit_of_measure, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('prod1', 'Beef Steak', 'Meat', 8500, 'kg', now, now);
    db.prepare(
      `INSERT INTO price_history (id, product_id, old_price, new_price, changed_by, datetime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p1', 'prod1', 1000, 1200, 'u1', now);
    expect(() => db!.prepare("UPDATE price_history SET new_price = 0 WHERE id = 'p1'").run()).toThrow(
      /append-only/,
    );
    expect(() => db!.prepare("DELETE FROM price_history WHERE id = 'p1'").run()).toThrow(/append-only/);
  });
});
