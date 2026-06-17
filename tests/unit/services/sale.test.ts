import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices } from '../helpers/db';
import type { Services } from '../../../src/main/services';
import type { DB } from '../../../src/main/db/connection';
import type { Product } from '../../../src/shared/types/domain';
import { toMinor } from '../../../src/shared/money';

describe('SaleService (M3)', () => {
  let db: DB;
  let services: Services;
  let cashier: { userId: string; username: string };
  let managerId: string;

  beforeEach(async () => {
    const made = makeServices();
    db = made.db;
    services = made.services;
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
  });

  function openSession(): string {
    const branchId = services.branches.getCurrentId();
    services.tills.open(cashier.userId, branchId, toMinor(200));
    return branchId;
  }
  const addBread = (): Product =>
    services.products.create(
      { name: 'Bread', category: 'Bakery', unitPrice: toMinor(15), unitOfMeasure: 'each' },
      'admin',
    );
  const addBeef = (): Product =>
    services.products.create(
      { name: 'Beef', category: 'Meat', unitPrice: toMinor(120), unitOfMeasure: 'kg', isWeightBased: true },
      'admin',
    );

  it('requires an open till session', () => {
    const p = addBread();
    expect(() =>
      services.sales.create(
        { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash', tendered: toMinor(50) },
        cashier,
      ),
    ).toThrow(/till session/i);
  });

  it('completes a cash sale, computing totals and change', () => {
    openSession();
    const bread = addBread();
    const { transaction, receipt } = services.sales.create(
      { items: [{ productId: bread.id, quantity: 2 }], paymentMethod: 'cash', tendered: toMinor(50) },
      cashier,
    );
    expect(transaction.grandTotal).toBe(toMinor(30));
    expect(transaction.changeDue).toBe(toMinor(20));
    expect(transaction.status).toBe('completed');
    expect(transaction.reference).toMatch(/-\d{6}$/);
    expect(receipt.text).toContain('TOTAL');
  });

  it('prices weight-based items by weight', () => {
    openSession();
    const beef = addBeef();
    const { transaction } = services.sales.create(
      { items: [{ productId: beef.id, quantity: 1.5 }], paymentMethod: 'card' },
      cashier,
    );
    expect(transaction.grandTotal).toBe(toMinor(180)); // 1.5kg * 120
  });

  it('rejects insufficient cash', () => {
    openSession();
    const bread = addBread();
    expect(() =>
      services.sales.create(
        { items: [{ productId: bread.id, quantity: 2 }], paymentMethod: 'cash', tendered: toMinor(10) },
        cashier,
      ),
    ).toThrow(/less than the total/i);
  });

  it('requires manager authorisation for a discount', () => {
    openSession();
    const bread = addBread();
    expect(() =>
      services.sales.create(
        {
          items: [{ productId: bread.id, quantity: 2 }],
          paymentMethod: 'card',
          transactionDiscount: toMinor(5),
        },
        cashier,
      ),
    ).toThrow(/permission/i);

    const { transaction } = services.sales.create(
      {
        items: [{ productId: bread.id, quantity: 2 }],
        paymentMethod: 'card',
        transactionDiscount: toMinor(5),
        authorisedBy: managerId,
      },
      cashier,
    );
    expect(transaction.discountTotal).toBe(toMinor(5));
    expect(transaction.grandTotal).toBe(toMinor(25));
  });

  it('decrements stock on sale and records a movement', () => {
    const branchId = openSession();
    const bread = addBread();
    services.sales.create({ items: [{ productId: bread.id, quantity: 3 }], paymentMethod: 'card' }, cashier);
    expect(services.inventory.getLevel(bread.id, branchId)).toBe(-3);
  });

  it('refunds an original sale, returning stock and referencing it', () => {
    const branchId = openSession();
    const bread = addBread();
    const sale = services.sales.create(
      { items: [{ productId: bread.id, quantity: 4 }], paymentMethod: 'cash', tendered: toMinor(100) },
      cashier,
    );
    const refund = services.sales.refund(
      { originalTxnId: sale.transaction.id, items: [{ productId: bread.id, quantity: 1 }] },
      cashier,
    );
    expect(refund.transaction.type).toBe('refund');
    expect(refund.transaction.originalTxnId).toBe(sale.transaction.id);
    expect(refund.transaction.grandTotal).toBe(toMinor(15));
    expect(services.inventory.getLevel(bread.id, branchId)).toBe(-3); // -4 sold, +1 returned
  });

  it('rejects refund quantity beyond what was sold', () => {
    openSession();
    const bread = addBread();
    const sale = services.sales.create(
      { items: [{ productId: bread.id, quantity: 1 }], paymentMethod: 'card' },
      cashier,
    );
    expect(() =>
      services.sales.refund(
        { originalTxnId: sale.transaction.id, items: [{ productId: bread.id, quantity: 5 }] },
        cashier,
      ),
    ).toThrow(/exceeds the quantity sold/i);
  });

  it('persists the sale atomically (transaction + items + movement + outbox)', () => {
    openSession();
    const bread = addBread();
    const sale = services.sales.create(
      { items: [{ productId: bread.id, quantity: 2 }], paymentMethod: 'card' },
      cashier,
    );
    const items = db
      .prepare('SELECT count(*) AS c FROM transaction_items WHERE transaction_id = ?')
      .get(sale.transaction.id) as { c: number };
    const moves = db
      .prepare("SELECT count(*) AS c FROM stock_movements WHERE reference_id = ? AND type = 'sale'")
      .get(sale.transaction.id) as { c: number };
    const outbox = db
      .prepare("SELECT count(*) AS c FROM sync_queue WHERE entity_type = 'transaction' AND entity_id = ?")
      .get(sale.transaction.id) as { c: number };
    expect(items.c).toBe(1);
    expect(moves.c).toBe(1);
    expect(outbox.c).toBe(1);
  });

  it('writes a session summary on close', () => {
    openSession();
    const bread = addBread();
    services.sales.create(
      { items: [{ productId: bread.id, quantity: 2 }], paymentMethod: 'cash', tendered: toMinor(50) },
      cashier,
    );
    const session = services.tills.getOpenForCashier(cashier.userId)!;
    const closed = services.tills.close(session.id, cashier.userId);
    expect(closed.status).toBe('closed');
    expect(closed.totals?.txnCount).toBe(1);
    expect(closed.totals?.totalCash).toBe(toMinor(30));
    expect(closed.totals?.totalSales).toBe(toMinor(30));
  });
});
