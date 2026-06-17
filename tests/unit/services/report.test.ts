import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices } from '../helpers/db';
import type { Services } from '../../../src/main/services';
import type { Product } from '../../../src/shared/types/domain';
import { toMinor } from '../../../src/shared/money';

const WIDE = { start: '2000-01-01T00:00:00.000Z', end: '2999-01-01T00:00:00.000Z' };

describe('ReportService (M6)', () => {
  let services: Services;
  let branchId: string;
  let cashier: { userId: string; username: string };
  let beef: Product;
  let bread: Product;

  beforeEach(async () => {
    services = makeServices().services;
    branchId = services.branches.getCurrentId();
    const c = await services.users.create({ username: 'till', password: 'tillpass1', role: 'cashier' }, 'system');
    cashier = { userId: c.id, username: c.username };
    services.tills.open(cashier.userId, branchId, toMinor(100));
    beef = services.products.create(
      { name: 'Beef', category: 'Meat', unitPrice: toMinor(100), unitOfMeasure: 'kg', isWeightBased: true },
      'system',
    );
    bread = services.products.create(
      { name: 'Bread', category: 'Bakery', unitPrice: toMinor(10), unitOfMeasure: 'each' },
      'system',
    );
  });

  it('aggregates net revenue, count, by-category and top products', () => {
    services.sales.create(
      {
        items: [
          { productId: beef.id, quantity: 2 }, // K200 Meat
          { productId: bread.id, quantity: 3 }, // K30 Bakery
        ],
        paymentMethod: 'cash',
        tendered: toMinor(300),
      },
      cashier,
    );
    const report = services.reports.salesReport(WIDE.start, WIDE.end, branchId);
    expect(report.totalRevenue).toBe(toMinor(230));
    expect(report.transactionCount).toBe(1);
    const meat = report.byCategory.find((c) => c.category === 'Meat')!;
    expect(meat.total).toBe(toMinor(200));
    expect(report.topProducts[0].name).toBe('Beef'); // highest total
  });

  it('subtracts refunds from revenue', () => {
    const sale = services.sales.create(
      { items: [{ productId: bread.id, quantity: 5 }], paymentMethod: 'cash', tendered: toMinor(100) },
      cashier,
    );
    services.sales.refund(
      { originalTxnId: sale.transaction.id, items: [{ productId: bread.id, quantity: 2 }] },
      cashier,
    );
    const report = services.reports.salesReport(WIDE.start, WIDE.end, branchId);
    expect(report.totalRevenue).toBe(toMinor(30)); // 50 sold - 20 refunded
  });

  it('excludes transactions outside the date range', () => {
    services.sales.create(
      { items: [{ productId: bread.id, quantity: 1 }], paymentMethod: 'card' },
      cashier,
    );
    const future = services.reports.salesReport('2999-01-01T00:00:00.000Z', '2999-12-31T00:00:00.000Z', branchId);
    expect(future.totalRevenue).toBe(0);
    expect(future.transactionCount).toBe(0);
  });

  it('lists transaction history (newest first) and stock movements', () => {
    services.sales.create(
      { items: [{ productId: bread.id, quantity: 1 }], paymentMethod: 'card' },
      cashier,
    );
    const txns = services.reports.transactions(branchId, {});
    expect(txns.length).toBe(1);
    expect(txns[0].type).toBe('sale');

    const moves = services.reports.stockMovements(branchId, {});
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves[0].productName).toBeTruthy();
    expect(moves[0].userName).toBe('till');
  });

  it('filters stock movements by type', () => {
    services.inventory.stockIn({ productId: bread.id, branchId, quantity: 10 }, cashier.userId);
    const stockIns = services.reports.stockMovements(branchId, { type: 'stock_in' });
    expect(stockIns.every((m) => m.type === 'stock_in')).toBe(true);
    expect(stockIns.length).toBe(1);
  });
});
