import { describe, it, expect } from 'vitest';
import { makeServices } from '../helpers/db';
import { HQ_CATALOGUE, type CatalogueItem } from '../../../src/main/catalogue/hq-catalogue';

const item = (over: Partial<CatalogueItem> = {}): CatalogueItem => ({
  name: 'Beef Stew',
  category: 'Beef',
  unitPrice: 10000,
  unitOfMeasure: 'kg',
  isWeightBased: true,
  barcodes: ['200002004650'],
  ...over,
});

async function withAdmin() {
  const { db, services } = makeServices();
  const { user } = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
  return { db, services, actorId: user.id };
}

describe('CatalogueService — planning', () => {
  it('plans every line as a create on an empty catalogue', async () => {
    const { services } = await withAdmin();
    const plan = services.catalogue.plan([item(), item({ name: 'Buns', barcodes: ['buns'] })]);

    expect(plan.toCreate).toBe(2);
    expect(plan.toAddBarcodes).toBe(0);
    expect(plan.conflicts).toEqual([]);
  });

  it('reports the products that will have no barcode', async () => {
    const { services } = await withAdmin();
    const plan = services.catalogue.plan([item({ name: 'Bread rolls', barcodes: [] })]);

    expect(plan.withoutBarcode).toEqual(['Bread rolls']);
  });
});

describe('CatalogueService — importing', () => {
  it('creates products with their barcodes, prices and units', async () => {
    const { services, actorId } = await withAdmin();
    const result = services.catalogue.import(actorId, [item()]);

    expect(result.created).toBe(1);
    const found = services.products.findByBarcode('200002004650');
    expect(found?.name).toBe('Beef Stew');
    expect(found?.unitPrice).toBe(10000);
    expect(found?.unitOfMeasure).toBe('kg');
    expect(found?.isWeightBased).toBe(true);
  });

  it('imports a product with no barcode, sellable by search', async () => {
    const { services, actorId } = await withAdmin();
    services.catalogue.import(actorId, [item({ name: 'Bread rolls', barcodes: [] })]);

    expect(services.products.search('Bread rolls')).toHaveLength(1);
  });

  it('is idempotent — a second run creates nothing', async () => {
    const { services, actorId } = await withAdmin();
    services.catalogue.import(actorId, [item()]);
    const second = services.catalogue.import(actorId, [item()]);

    expect(second.created).toBe(0);
    expect(second.barcodesAdded).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(services.products.list(true)).toHaveLength(1);
  });

  it('adds a missing barcode to a product a manager already typed in', async () => {
    const { services, actorId } = await withAdmin();
    services.products.create(
      { name: 'Beef Stew', category: 'Beef', unitPrice: 9500, unitOfMeasure: 'kg' },
      actorId,
    );
    const result = services.catalogue.import(actorId, [item()]);

    expect(result.created).toBe(0);
    expect(result.barcodesAdded).toBe(1);
    expect(services.products.findByBarcode('200002004650')?.name).toBe('Beef Stew');
  });

  it('leaves a price the shop has already set alone', async () => {
    const { services, actorId } = await withAdmin();
    const existing = services.products.create(
      { name: 'Beef Stew', category: 'Beef', unitPrice: 9500, unitOfMeasure: 'kg' },
      actorId,
    );
    services.catalogue.import(actorId, [item({ unitPrice: 10000 })]);

    // The till is the authority on its own prices; the catalogue only fills gaps.
    expect(services.products.get(existing.id)?.unitPrice).toBe(9500);
  });

  it('never steals a barcode that belongs to another product', async () => {
    const { services, actorId } = await withAdmin();
    services.products.create(
      {
        name: 'Something else entirely',
        category: 'Grocery',
        unitPrice: 500,
        unitOfMeasure: 'each',
        barcodes: [{ barcode: '200002004650' }],
      },
      actorId,
    );
    // Matches on barcode, so it resolves to the existing product rather than
    // creating a clash.
    const plan = services.catalogue.plan([item()]);
    expect(plan.toCreate).toBe(0);

    const result = services.catalogue.import(actorId, [item()]);
    expect(result.failed).toEqual([]);
    expect(services.products.findByBarcode('200002004650')?.name).toBe('Something else entirely');
  });

  it('does not let two catalogue lines claim the same barcode', async () => {
    const { services, actorId } = await withAdmin();
    const result = services.catalogue.import(actorId, [
      item({ name: 'First', barcodes: ['SHARED'] }),
      item({ name: 'Second', barcodes: ['SHARED'] }),
    ]);

    expect(result.created).toBe(2);
    expect(result.failed).toHaveLength(0);
    // Exactly one of them ends up holding it — the UNIQUE index is never violated.
    expect(services.products.findByBarcode('SHARED')).not.toBeNull();
  });

  it('writes an audit trail and outbox rows, like any hand-typed product', async () => {
    const { db, services, actorId } = await withAdmin();
    services.catalogue.import(actorId, [item()]);

    const audits = db
      .prepare("SELECT count(*) AS c FROM audit_log WHERE action = 'product_create'")
      .get() as { c: number };
    const outbox = db
      .prepare("SELECT count(*) AS c FROM sync_queue WHERE entity_type = 'product'")
      .get() as { c: number };

    expect(audits.c).toBe(1);
    expect(outbox.c).toBe(1);
  });

  it('imports no stock — opening quantities come from a stock count', async () => {
    const { db, services, actorId } = await withAdmin();
    services.catalogue.import(actorId, [item()]);

    const inv = db.prepare('SELECT count(*) AS c FROM inventory').get() as { c: number };
    const moves = db.prepare('SELECT count(*) AS c FROM stock_movements').get() as { c: number };
    expect(inv.c).toBe(0);
    expect(moves.c).toBe(0);
  });
});

describe('the shipped HQ catalogue', () => {
  it('carries every line from the export', () => {
    expect(HQ_CATALOGUE).toHaveLength(486);
  });

  it('has a name, category, positive price and a valid unit on every line', () => {
    for (const i of HQ_CATALOGUE) {
      expect(i.name.length).toBeGreaterThan(0);
      expect(i.category.length).toBeGreaterThan(0);
      expect(Number.isInteger(i.unitPrice)).toBe(true);
      expect(i.unitPrice).toBeGreaterThan(0);
      expect(['each', 'kg']).toContain(i.unitOfMeasure);
      expect(i.isWeightBased).toBe(i.unitOfMeasure === 'kg');
    }
  });

  it('never puts the same barcode on two products', () => {
    const all = HQ_CATALOGUE.flatMap((i) => i.barcodes);
    expect(new Set(all).size).toBe(all.length);
  });

  it('imports whole into a fresh till, then re-imports as a no-op', async () => {
    const { services, actorId } = await withAdmin();
    const first = services.catalogue.import(actorId);

    expect(first.created).toBe(HQ_CATALOGUE.length);
    expect(first.failed).toEqual([]);
    expect(services.products.list(true)).toHaveLength(HQ_CATALOGUE.length);

    const second = services.catalogue.import(actorId);
    expect(second.created).toBe(0);
    expect(second.barcodesAdded).toBe(0);
    expect(second.unchanged).toBe(HQ_CATALOGUE.length);
  });

  it('keeps products whose names differ only by case apart', async () => {
    // The export really does hold both, at different prices and barcodes; an
    // earlier version folded one into the other.
    const { services, actorId } = await withAdmin();
    services.catalogue.import(actorId, [
      item({ name: 'Mansa sugar 1kg', category: 'Groceries', barcodes: ['710535375404'] }),
      item({ name: 'Mansa Sugar 1kg', category: 'Groceries', barcodes: ['710535375244'] }),
    ]);

    expect(services.products.findByBarcode('710535375404')?.name).toBe('Mansa sugar 1kg');
    expect(services.products.findByBarcode('710535375244')?.name).toBe('Mansa Sugar 1kg');
  });

  it('makes every coded product findable by scanning it', async () => {
    const { services, actorId } = await withAdmin();
    services.catalogue.import(actorId);

    const coded = HQ_CATALOGUE.filter((i) => i.barcodes.length > 0);
    expect(coded).toHaveLength(481);
    for (const i of coded) {
      expect(services.products.findByBarcode(i.barcodes[0])?.name).toBe(i.name);
    }
  });
});
