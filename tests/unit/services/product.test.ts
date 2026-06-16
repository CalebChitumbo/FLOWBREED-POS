import { describe, it, expect } from 'vitest';
import { makeServices } from '../helpers/db';
import { toMinor } from '../../../src/shared/money';

const ACTOR = 'actor-1';

describe('ProductService (M2)', () => {
  it('creates a product with multiple barcodes and reads it back', () => {
    const { services } = makeServices();
    const p = services.products.create(
      {
        name: 'Beef Sausages',
        category: 'Meat',
        unitPrice: toMinor(85),
        unitOfMeasure: 'each',
        barcodes: [
          { barcode: '6001001', packLabel: 'single' },
          { barcode: '6001002', packLabel: '6-pack' },
        ],
      },
      ACTOR,
    );
    expect(p.unitPrice).toBe(8500);
    const fetched = services.products.get(p.id)!;
    expect(fetched.barcodes).toHaveLength(2);
  });

  it('finds a product by any of its barcodes (scan hot path)', () => {
    const { services } = makeServices();
    const p = services.products.create(
      { name: 'Bread', category: 'Bakery', unitPrice: 1500, unitOfMeasure: 'each', barcodes: [{ barcode: '111' }] },
      ACTOR,
    );
    expect(services.products.findByBarcode('111')?.id).toBe(p.id);
    expect(services.products.findByBarcode('does-not-exist')).toBeNull();
  });

  it('searches by name and by barcode prefix (active only)', () => {
    const { services } = makeServices();
    services.products.create(
      { name: 'Goat Meat', category: 'Meat', unitPrice: 9000, unitOfMeasure: 'kg', barcodes: [{ barcode: '7700' }] },
      ACTOR,
    );
    expect(services.products.search('goat').length).toBe(1);
    expect(services.products.search('77').length).toBe(1); // barcode prefix
    expect(services.products.search('zzz').length).toBe(0);
  });

  it('rejects a duplicate barcode', () => {
    const { services } = makeServices();
    services.products.create(
      { name: 'A', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each', barcodes: [{ barcode: 'DUP' }] },
      ACTOR,
    );
    expect(() =>
      services.products.create(
        { name: 'B', category: 'Grocery', unitPrice: 200, unitOfMeasure: 'each', barcodes: [{ barcode: 'DUP' }] },
        ACTOR,
      ),
    ).toThrow(/already assigned/i);
  });

  it('adds and removes barcodes', () => {
    const { services } = makeServices();
    const p = services.products.create({ name: 'C', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, ACTOR);
    const bc = services.products.addBarcode(p.id, { barcode: 'NEW1' }, ACTOR);
    expect(services.products.findByBarcode('NEW1')?.id).toBe(p.id);
    services.products.removeBarcode(bc.id, ACTOR);
    expect(services.products.findByBarcode('NEW1')).toBeNull();
  });

  it('supports weight-based products', () => {
    const { services } = makeServices();
    const p = services.products.create(
      { name: 'Beef Fillet', category: 'Meat', unitPrice: toMinor(120), unitOfMeasure: 'kg', isWeightBased: true },
      ACTOR,
    );
    expect(services.products.get(p.id)!.isWeightBased).toBe(true);
  });

  it('logs price history only when the price changes', () => {
    const { services } = makeServices();
    const p = services.products.create({ name: 'D', category: 'Grocery', unitPrice: 1000, unitOfMeasure: 'each' }, ACTOR);
    services.products.update(p.id, { name: 'D renamed' }, ACTOR); // no price change
    expect(services.products.priceHistory(p.id)).toHaveLength(0);
    services.products.update(p.id, { unitPrice: 1250 }, ACTOR); // price change
    const hist = services.products.priceHistory(p.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ oldPrice: 1000, newPrice: 1250, changedBy: ACTOR });
  });

  it('deactivates without deleting and hides from default list/search', () => {
    const { services } = makeServices();
    const p = services.products.create({ name: 'Old Item', category: 'Grocery', unitPrice: 500, unitOfMeasure: 'each' }, ACTOR);
    services.products.update(p.id, { active: false }, ACTOR);
    expect(services.products.list()).toHaveLength(0);
    expect(services.products.list(true)).toHaveLength(1); // still exists
    expect(services.products.search('Old')).toHaveLength(0);
  });

  it('enqueues product + price_history changes to the sync outbox', () => {
    const { db, services } = makeServices();
    const p = services.products.create({ name: 'E', category: 'Grocery', unitPrice: 100, unitOfMeasure: 'each' }, ACTOR);
    services.products.update(p.id, { unitPrice: 200 }, ACTOR);
    const counts = db
      .prepare("SELECT entity_type, count(*) AS c FROM sync_queue GROUP BY entity_type")
      .all() as { entity_type: string; c: number }[];
    const byType = Object.fromEntries(counts.map((r) => [r.entity_type, r.c]));
    expect(byType.product).toBeGreaterThanOrEqual(2); // create + update
    expect(byType.price_history).toBeGreaterThanOrEqual(1);
  });
});
