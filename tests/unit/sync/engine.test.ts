import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices } from '../helpers/db';
import type { Services } from '../../../src/main/services';
import type { DB } from '../../../src/main/db/connection';
import { SyncEngine } from '../../../src/main/sync/engine';
import { InMemoryTransport } from '../../../src/main/sync/memory-transport';
import { toMinor } from '../../../src/shared/money';

function pending(db: DB): number {
  return (db.prepare("SELECT count(*) AS c FROM sync_queue WHERE status='pending'").get() as { c: number }).c;
}

describe('SyncEngine (M7)', () => {
  let db: DB;
  let services: Services;
  let transport: InMemoryTransport;
  let engine: SyncEngine;

  beforeEach(() => {
    const made = makeServices();
    db = made.db;
    services = made.services;
    transport = new InMemoryTransport();
    engine = new SyncEngine(db, transport, services.config);
  });

  it('drains the outbox to the transport and marks rows synced', async () => {
    services.products.create({ name: 'A', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, 'sys');
    expect(pending(db)).toBeGreaterThan(0);
    await engine.tick();
    expect(pending(db)).toBe(0);
    // product row marked synced + present in the "cloud"
    const product = db.prepare("SELECT sync_status FROM products LIMIT 1").get() as { sync_status: string };
    expect(product.sync_status).toBe('synced');
  });

  it('is idempotent — a second push creates no duplicates', async () => {
    const p = services.products.create({ name: 'B', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, 'sys');
    await engine.tick();
    await engine.tick();
    expect(transport.getStored('product', p.id)).toBeTruthy();
    expect(pending(db)).toBe(0);
  });

  it('accumulates the outbox while offline and drains on reconnect', async () => {
    transport.setOnline(false);
    services.products.create({ name: 'C', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, 'sys');
    const before = pending(db);
    await engine.tick();
    expect(pending(db)).toBe(before); // nothing pushed offline
    transport.setOnline(true);
    await engine.tick();
    expect(pending(db)).toBe(0);
  });

  it('retries failed pushes (increments retry_count, keeps pending)', async () => {
    const p = services.products.create({ name: 'D', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, 'sys');
    transport.failOn(p.id);
    await engine.tick();
    const row = db
      .prepare("SELECT status, retry_count FROM sync_queue WHERE entity_type='product' AND entity_id=?")
      .get(p.id) as { status: string; retry_count: number };
    expect(row.retry_count).toBe(1);
    expect(row.status).toBe('pending');
  });

  it('reports online + pending status', async () => {
    services.products.create({ name: 'E', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, 'sys');
    transport.setOnline(false);
    const status = await engine.tick();
    expect(status.online).toBe(false);
    expect(status.pending).toBeGreaterThan(0);
  });

  it('pulls a newer head-office product change and applies it (LWW)', async () => {
    const p = services.products.create(
      { name: 'Sugar', category: 'Grocery', unitPrice: toMinor(20), unitOfMeasure: 'each' },
      'sys',
    );
    await engine.tick(); // push it up first
    const future = new Date(Date.now() + 60_000).toISOString();
    transport.seed('product', p.id, { name: 'Sugar', category: 'Grocery', unitPrice: toMinor(25), unitOfMeasure: 'each', active: 1 }, future);
    await engine.tick();
    const local = db.prepare('SELECT unit_price FROM products WHERE id=?').get(p.id) as { unit_price: number };
    expect(local.unit_price).toBe(toMinor(25));
    // a price-history entry from the cloud was logged
    const hist = db
      .prepare("SELECT changed_by FROM price_history WHERE product_id=? ORDER BY datetime DESC")
      .get(p.id) as { changed_by: string } | undefined;
    expect(hist?.changed_by).toBe('cloud:headoffice');
  });

  it('never pushes password hashes to the cloud', async () => {
    const user = await services.users.create(
      { username: 'cash1', password: 'longenough1', role: 'cashier' },
      'admin',
    );
    await engine.tick();
    const stored = transport.getStored('user', user.id);
    expect(stored).toBeTruthy();
    expect(stored).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(stored)).not.toContain('argon2');
  });

  it('ignores an older head-office change (local wins)', async () => {
    const p = services.products.create(
      { name: 'Salt', category: 'Grocery', unitPrice: toMinor(10), unitOfMeasure: 'each' },
      'sys',
    );
    const past = new Date(Date.now() - 60_000).toISOString();
    transport.seed('product', p.id, { name: 'Salt', unitPrice: toMinor(99), category: 'Grocery', active: 1 }, past);
    await engine.tick();
    const local = db.prepare('SELECT unit_price FROM products WHERE id=?').get(p.id) as { unit_price: number };
    expect(local.unit_price).toBe(toMinor(10)); // unchanged
  });
});
