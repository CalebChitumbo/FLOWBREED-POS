import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices } from '../helpers/db';
import type { Services } from '../../../src/main/services';
import type { DB } from '../../../src/main/db/connection';
import type { Product } from '../../../src/shared/types/domain';
import { toMinor } from '../../../src/shared/money';
import { FinancialBridge } from '../../../src/main/financial/bridge';
import { FINHUB_KEYS } from '../../../src/main/financial/keys';
import { saleDocId, businessDate } from '../../../src/main/financial/mapping';
import { FakeFinancialStore } from './fake-store';

const SHOP = 'outlet';

describe('FinancialBridge', () => {
  let db: DB;
  let services: Services;
  let store: FakeFinancialStore;
  let bridge: FinancialBridge;
  let cashier: { userId: string; username: string };
  let managerId: string;

  beforeEach(async () => {
    const made = makeServices();
    db = made.db;
    services = made.services;
    store = new FakeFinancialStore();
    bridge = new FinancialBridge({
      db,
      config: services.config,
      store,
      branches: services.branches,
      inventory: services.inventory,
      audit: services.audit,
      outbox: services.outbox,
    });
    services.config.set(FINHUB_KEYS.shopId, SHOP);
    services.config.set(FINHUB_KEYS.terminalId, 'till-1');
    const c = await services.users.create(
      { username: 'cashier', password: 'cashpass1', role: 'cashier' },
      'admin',
    );
    const m = await services.users.create(
      { username: 'manager', password: 'managerpass', role: 'manager' },
      'admin',
    );
    cashier = { userId: c.id, username: c.username };
    managerId = m.id;
    services.tills.open(cashier.userId, services.branches.getCurrentId(), toMinor(200));
  });

  const addProduct = (name: string, priceK: number, extra: Record<string, unknown> = {}): Product =>
    services.products.create(
      { name, category: 'Bakery', unitPrice: toMinor(priceK), unitOfMeasure: 'each', ...extra },
      'admin',
    );

  const sell = (productId: string, quantity: number, extras: Record<string, unknown> = {}) =>
    services.sales.create(
      {
        items: [{ productId, quantity }],
        paymentMethod: 'cash',
        tendered: toMinor(100_000),
        ...extras,
      } as Parameters<typeof services.sales.create>[0],
      cashier,
    );

  const today = (): string => businessDate(new Date().toISOString());
  const docId = (): string => saleDocId(today(), SHOP, 'till-1');
  const future = (secs: number): string => new Date(Date.now() + secs * 1000).toISOString();

  // Timestamps carry millisecond resolution; settle 2ms before each run so a
  // domain write can never share a stamp with the run's high-water mark, which
  // keeps the "second run pushes nothing" assertions exact.
  const settle = () => new Promise((r) => setTimeout(r, 2));
  const runBridge = async () => {
    await settle();
    return bridge.run();
  };

  it('refuses to run until the branch is mapped to a Financial shop', async () => {
    services.config.set(FINHUB_KEYS.shopId, '');
    const result = await runBridge();
    expect(result.errors.join(' ')).toMatch(/Financial-app shop/);
    expect(store.shopSales.size).toBe(0);
  });

  describe('sales push', () => {
    it("pushes the day's takings as one deterministic shopSales doc", async () => {
      const bread = addProduct('Bread', 15);
      sell(bread.id, 2);
      sell(bread.id, 1);

      const result = await runBridge();
      expect(result.errors).toEqual([]);
      expect(result.pushedSaleDays).toEqual([today()]);

      const doc = store.shopSales.get(docId());
      expect(doc).toBeTruthy();
      expect(doc!.source).toBe('POS');
      expect(doc!.shopId).toBe(SHOP);
      expect(doc!.terminalId).toBe('till-1');
      expect(doc!.lines).toHaveLength(1);
      expect(doc!.lines[0]).toMatchObject({ productName: 'Bread', quantity: 3, unitPrice: 15, amount: 45 });
      expect(doc!.total).toBe(45);
    });

    it('is idempotent, and a later sale corrects the same day doc', async () => {
      const bread = addProduct('Bread', 15);
      sell(bread.id, 2);
      await runBridge();
      const first = store.shopSales.get(docId())!;

      const quiet = await runBridge();
      expect(quiet.pushedSaleDays).toEqual([]); // nothing changed, nothing pushed

      sell(bread.id, 3);
      await runBridge();
      const updated = store.shopSales.get(docId())!;
      expect(updated.total).toBe(75);
      expect(store.shopSales.size).toBe(1); // corrected, never duplicated
      expect(updated.createdAt).toBe(first.createdAt); // first-entry time preserved
    });

    it('nets refunds and posts discounts as negative Other sales', async () => {
      const bread = addProduct('Bread', 15);
      const sale = sell(bread.id, 4, { transactionDiscount: toMinor(5), authorisedBy: managerId });
      services.sales.refund(
        { originalTxnId: sale.transaction.id, items: [{ productId: bread.id, quantity: 1 }] },
        cashier,
      );

      await runBridge();
      const doc = store.shopSales.get(docId())!;
      // 4 sold − 1 refunded at K15, minus K5 discount -> K40 net
      expect(doc.lines[0].quantity).toBe(3);
      expect(doc.otherSales).toBe(-5);
      expect(doc.total).toBe(40);
    });

    it('does not advance the mark when the cloud write fails', async () => {
      const bread = addProduct('Bread', 15);
      sell(bread.id, 2);
      store.failWrites = true;
      const failed = await runBridge();
      expect(failed.errors.join(' ')).toMatch(/simulated cloud failure/);

      store.failWrites = false;
      const retry = await runBridge();
      expect(retry.pushedSaleDays).toEqual([today()]);
      expect(store.shopSales.get(docId())!.total).toBe(30);
    });

    it('uses the Financial catalogue id for linked products', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      sell(bread.id, 2);
      await runBridge();
      expect(store.shopSales.get(docId())!.lines[0].productId).toBe('fin-bread');
    });
  });

  describe('catalogue pull', () => {
    it('imports a Financial product sold at this shop and links it', async () => {
      store.products = [
        {
          id: 'fin-buns',
          name: 'Buns',
          unit: 'each',
          orderPrice: 2,
          retailPrice: 2.5,
          shopIds: [SHOP],
          tracksStock: true,
          active: true,
          updatedAt: future(60),
        },
      ];
      const result = await runBridge();
      expect(result.pulledProducts).toBe(1);
      const local = db
        .prepare('SELECT * FROM products WHERE financial_id = ?')
        .get('fin-buns') as { name: string; unit_price: number; active: number };
      expect(local).toMatchObject({ name: 'Buns', unit_price: 250, active: 1 });

      // Second run: nothing newer than the mark -> no change.
      const again = await runBridge();
      expect(again.pulledProducts).toBe(0);
    });

    it('ignores products not sold at this shop', async () => {
      store.products = [
        {
          id: 'fin-elsewhere',
          name: 'Restaurant Plate',
          unit: 'each',
          orderPrice: 0,
          retailPrice: 50,
          shopIds: ['restaurant'],
          tracksStock: false,
          active: true,
          updatedAt: future(60),
        },
      ];
      await runBridge();
      expect(db.prepare('SELECT count(*) AS c FROM products').get()).toMatchObject({ c: 0 });
    });

    it('auto-links an existing product by name instead of duplicating it', async () => {
      const bread = addProduct('Bread', 15);
      store.products = [
        {
          id: 'fin-bread',
          name: 'bread', // case-insensitive match
          unit: 'each',
          orderPrice: 12,
          retailPrice: 16,
          shopIds: [SHOP],
          tracksStock: true,
          active: true,
          updatedAt: future(60),
        },
      ];
      await runBridge();
      const row = db.prepare('SELECT financial_id, unit_price FROM products WHERE id = ?').get(bread.id) as {
        financial_id: string;
        unit_price: number;
      };
      expect(row.financial_id).toBe('fin-bread');
      expect(row.unit_price).toBe(toMinor(16)); // central price wins (newer stamp)
      expect(db.prepare('SELECT count(*) AS c FROM products').get()).toMatchObject({ c: 1 });
    });

    it('records price history when the central price changes', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      store.products = [
        {
          id: 'fin-bread',
          name: 'Bread',
          unit: 'each',
          orderPrice: 12,
          retailPrice: 18,
          shopIds: [SHOP],
          tracksStock: true,
          active: true,
          updatedAt: future(60),
        },
      ];
      await runBridge();
      const hist = db
        .prepare('SELECT old_price, new_price, changed_by FROM price_history WHERE product_id = ? ORDER BY datetime DESC')
        .get(bread.id) as { old_price: number; new_price: number; changed_by: string };
      expect(hist).toMatchObject({ old_price: toMinor(15), new_price: toMinor(18), changed_by: 'financial-hub' });
    });

    it('respects a newer local edit (LWW)', async () => {
      const bread = addProduct('Bread', 15); // updated_at = now
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      store.products = [
        {
          id: 'fin-bread',
          name: 'Bread',
          unit: 'each',
          orderPrice: 12,
          retailPrice: 99,
          shopIds: [SHOP],
          tracksStock: true,
          active: true,
          updatedAt: new Date(Date.now() - 60_000).toISOString(), // older than local
        },
      ];
      await runBridge();
      const row = db.prepare('SELECT unit_price FROM products WHERE id = ?').get(bread.id) as {
        unit_price: number;
      };
      expect(row.unit_price).toBe(toMinor(15));
    });

    it('deactivates a product withdrawn from the central catalogue', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      store.products = [
        {
          id: 'fin-bread',
          name: 'Bread',
          unit: 'each',
          orderPrice: 12,
          retailPrice: 15,
          shopIds: [SHOP],
          tracksStock: true,
          active: false,
          updatedAt: future(60),
        },
      ];
      await runBridge();
      const row = db.prepare('SELECT active FROM products WHERE id = ?').get(bread.id) as { active: number };
      expect(row.active).toBe(0);
    });
  });

  describe('HQ deliveries', () => {
    function seedDelivery(qty: number, updatedAt: string, id = 'mv-1'): void {
      store.movements = [
        {
          id,
          date: today(),
          kind: 'SUPPLY',
          fromShopId: null,
          toShopId: SHOP,
          destination: '',
          source: 'HQ Production',
          lines: [{ productId: 'fin-bread', productName: 'Bread', unit: 'each', quantity: qty }],
          note: 'morning bake',
          updatedAt,
        },
      ];
    }

    it('applies a delivery to local stock exactly once', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      seedDelivery(40, future(30));

      const result = await runBridge();
      expect(result.appliedMovements).toBe(1);
      expect(services.inventory.getLevel(bread.id, services.branches.getCurrentId())).toBe(40);

      const again = await runBridge();
      expect(again.appliedMovements).toBe(0);
      expect(services.inventory.getLevel(bread.id, services.branches.getCurrentId())).toBe(40);
    });

    it('subtracts a transfer away from this shop', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      store.movements = [
        {
          id: 'mv-out',
          date: today(),
          kind: 'TRANSFER',
          fromShopId: SHOP,
          toShopId: 'restaurant',
          destination: '',
          source: 'HQ Production',
          lines: [{ productId: 'fin-bread', productName: 'Bread', unit: 'each', quantity: 10 }],
          note: '',
          updatedAt: future(30),
        },
      ];
      await runBridge();
      expect(services.inventory.getLevel(bread.id, services.branches.getCurrentId())).toBe(-10);
    });

    it('warns instead of re-applying a delivery edited at HQ after application', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      seedDelivery(40, future(30));
      await runBridge();

      seedDelivery(45, future(120)); // edited later at HQ
      const result = await runBridge();
      expect(result.appliedMovements).toBe(0);
      expect(result.warnings.join(' ')).toMatch(/edited in the Financial app/);
      expect(services.inventory.getLevel(bread.id, services.branches.getCurrentId())).toBe(40);
    });

    it('surfaces unlinked delivery lines as warnings', async () => {
      seedDelivery(40, future(30)); // no local product linked to fin-bread
      const result = await runBridge();
      expect(result.warnings.join(' ')).toMatch(/no matching POS product/);
    });

    it('ignores movements between other shops', async () => {
      store.movements = [
        {
          id: 'mv-other',
          date: today(),
          kind: 'TRANSFER',
          fromShopId: 'main',
          toShopId: 'restaurant',
          destination: '',
          source: 'HQ Production',
          lines: [{ productId: 'fin-bread', productName: 'Bread', unit: 'each', quantity: 5 }],
          note: '',
          updatedAt: future(30),
        },
      ];
      const result = await runBridge();
      expect(result.appliedMovements).toBe(0);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('local stock push', () => {
    it('pushes a stock-in as a Financial SUPPLY purchase, idempotently', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      services.inventory.stockIn(
        { productId: bread.id, branchId: services.branches.getCurrentId(), quantity: 30, notes: 'local bake' },
        managerId,
      );

      const result = await runBridge();
      expect(result.pushedMovements).toBe(1);
      const [docId, doc] = [...store.stockMovements.entries()][0];
      expect(docId).toMatch(/^pos-/);
      expect(doc).toMatchObject({ kind: 'SUPPLY', source: 'Purchase', toShopId: SHOP });
      expect(doc.lines[0]).toMatchObject({ productId: 'fin-bread', quantity: 30 });

      const again = await runBridge();
      expect(again.pushedMovements).toBe(0);
    });

    it('pushes a stock loss as an ADHOC movement out of the shop', async () => {
      const bread = addProduct('Bread', 15);
      const branchId = services.branches.getCurrentId();
      services.inventory.stockIn({ productId: bread.id, branchId, quantity: 10 }, managerId);
      services.inventory.adjust(
        { productId: bread.id, branchId, newQuantity: 7, reason: 'spoilage' },
        managerId,
      );

      const result = await runBridge();
      expect(result.pushedMovements).toBe(2);
      const adhoc = [...store.stockMovements.values()].find((d) => d.kind === 'ADHOC');
      expect(adhoc).toBeTruthy();
      expect(adhoc!.fromShopId).toBe(SHOP);
      expect(adhoc!.lines[0].quantity).toBe(3);
      expect(adhoc!.note).toContain('spoilage');
    });

    it('never echoes deliveries the bridge itself applied', async () => {
      const bread = addProduct('Bread', 15);
      db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run('fin-bread', bread.id);
      store.movements = [
        {
          id: 'mv-1',
          date: today(),
          kind: 'SUPPLY',
          fromShopId: null,
          toShopId: SHOP,
          destination: '',
          source: 'HQ Production',
          lines: [{ productId: 'fin-bread', productName: 'Bread', unit: 'each', quantity: 40 }],
          note: '',
          updatedAt: future(30),
        },
      ];
      const result = await runBridge();
      expect(result.appliedMovements).toBe(1);
      expect(result.pushedMovements).toBe(0);
      expect(store.stockMovements.size).toBe(0);
    });
  });
});
