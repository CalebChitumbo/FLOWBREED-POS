import { describe, it, expect } from 'vitest';
import {
  businessDate,
  buildShopSaleDoc,
  movementToStockOps,
  ngweeToKwacha,
  posMovementToFinancialDoc,
  saleDocId,
  sqlBusinessDayModifier,
  type BuildShopSaleInput,
  type DayLineAgg,
} from '../../../src/main/financial/mapping';
import type { FinancialStockMovementDoc } from '../../../src/main/financial/types';

const NOW = '2026-09-01T10:00:00.000Z';

function baseInput(rows: DayLineAgg[], overrides: Partial<BuildShopSaleInput> = {}): BuildShopSaleInput {
  return {
    date: '2026-09-01',
    shopId: 'outlet',
    terminalId: 'till-1',
    branchName: 'Outlet Branch',
    rows,
    saleDiscountNgwee: 0,
    saleCount: 1,
    refundCount: 0,
    financialIdByProduct: new Map(),
    nowIso: NOW,
    ...overrides,
  };
}

const agg = (over: Partial<DayLineAgg>): DayLineAgg => ({
  productId: 'pos-p1',
  productName: 'Bread',
  unit: 'each',
  unitPriceNgwee: 1500,
  txnType: 'sale',
  quantity: 2,
  grossNgwee: 3000,
  ...over,
});

describe('business day conversion (Africa/Lusaka, UTC+2)', () => {
  it('maps a late-evening UTC instant onto the next local day', () => {
    expect(businessDate('2026-08-31T22:30:00.000Z')).toBe('2026-09-01');
  });

  it('keeps an instant just before the local midnight boundary on the same day', () => {
    expect(businessDate('2026-08-31T21:59:59.000Z')).toBe('2026-08-31');
  });

  it('produces a matching SQLite modifier', () => {
    expect(sqlBusinessDayModifier()).toBe('+120 minutes');
    expect(sqlBusinessDayModifier(-330)).toBe('-330 minutes');
  });
});

describe('money conversion', () => {
  it('converts ngwee to exact kwacha', () => {
    expect(ngweeToKwacha(1550)).toBe(15.5);
    expect(ngweeToKwacha(1)).toBe(0.01);
    expect(ngweeToKwacha(0)).toBe(0);
  });
});

describe('buildShopSaleDoc', () => {
  it('builds one line per product/price with exact ZMW amounts', () => {
    const doc = buildShopSaleDoc(baseInput([agg({})]));
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      productId: 'pos-p1',
      productName: 'Bread',
      unit: 'each',
      quantity: 2,
      priceType: 'retail',
      unitPrice: 15,
      amount: 30,
    });
    expect(doc.total).toBe(30);
    expect(doc.otherSales).toBe(0);
    expect(doc.source).toBe('POS');
    expect(doc.terminalId).toBe('till-1');
    expect(doc.updatedBy).toBe('pos:till-1');
  });

  it('keeps the same product at two prices as two lines', () => {
    const doc = buildShopSaleDoc(
      baseInput([
        agg({ unitPriceNgwee: 1500, quantity: 2, grossNgwee: 3000 }),
        agg({ unitPriceNgwee: 1200, quantity: 5, grossNgwee: 6000 }),
      ]),
    );
    expect(doc.lines).toHaveLength(2);
    expect(doc.total).toBe(90);
  });

  it('nets refunds against sales at the price they were rung at', () => {
    const doc = buildShopSaleDoc(
      baseInput([
        agg({ quantity: 5, grossNgwee: 7500 }),
        agg({ txnType: 'refund', quantity: 2, grossNgwee: 3000 }),
      ]),
    );
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].quantity).toBe(3);
    expect(doc.lines[0].amount).toBe(45);
    expect(doc.total).toBe(45);
  });

  it('drops fully cancelled-out lines but keeps refund excess as a negative line', () => {
    const cancelled = buildShopSaleDoc(
      baseInput([
        agg({ quantity: 2, grossNgwee: 3000 }),
        agg({ txnType: 'refund', quantity: 2, grossNgwee: 3000 }),
      ]),
    );
    expect(cancelled.lines).toHaveLength(0);
    expect(cancelled.total).toBe(0);

    const excess = buildShopSaleDoc(
      baseInput([agg({ txnType: 'refund', quantity: 1, grossNgwee: 1500 })]),
    );
    expect(excess.lines[0].quantity).toBe(-1);
    expect(excess.total).toBe(-15);
  });

  it('posts discounts as negative Other sales so total equals net money taken', () => {
    // Sale: 2 × K15 with a K5 discount -> customer paid K25.
    const doc = buildShopSaleDoc(
      baseInput([agg({ quantity: 2, grossNgwee: 3000 })], { saleDiscountNgwee: 500 }),
    );
    expect(doc.lines[0].amount).toBe(30);
    expect(doc.otherSales).toBe(-5);
    expect(doc.total).toBe(25);
    expect(doc.notes).toContain('K5.00');
  });

  it('substitutes the Financial catalogue id for linked products', () => {
    const doc = buildShopSaleDoc(
      baseInput([agg({})], { financialIdByProduct: new Map([['pos-p1', 'fin-bread']]) }),
    );
    expect(doc.lines[0].productId).toBe('fin-bread');
  });

  it('keeps weight-based fractional quantities', () => {
    const doc = buildShopSaleDoc(
      baseInput([
        agg({ productName: 'Beef', unit: 'kg', unitPriceNgwee: 12000, quantity: 1.25, grossNgwee: 15000 }),
      ]),
    );
    expect(doc.lines[0].quantity).toBe(1.25);
    expect(doc.lines[0].amount).toBe(150);
  });

  it('produces an empty but valid doc for a day whose entries were all voided', () => {
    const doc = buildShopSaleDoc(baseInput([], { saleCount: 0 }));
    expect(doc.lines).toHaveLength(0);
    expect(doc.total).toBe(0);
  });
});

describe('saleDocId', () => {
  it('is deterministic per day/shop/terminal', () => {
    expect(saleDocId('2026-09-01', 'outlet', 'till-1')).toBe('2026-09-01__outlet__pos__till-1');
  });
});

describe('movementToStockOps', () => {
  const links = new Map([['fin-bread', 'pos-p1']]);
  const movement = (over: Partial<FinancialStockMovementDoc>): FinancialStockMovementDoc => ({
    date: '2026-09-01',
    kind: 'SUPPLY',
    fromShopId: null,
    toShopId: 'outlet',
    destination: '',
    source: 'HQ Production',
    lines: [{ productId: 'fin-bread', productName: 'Bread', unit: 'each', quantity: 40 }],
    note: '',
    ...over,
  });

  it('applies a supply to this shop as stock in', () => {
    const result = movementToStockOps(movement({}), 'outlet', links);
    expect(result.relevant).toBe(true);
    expect(result.ops).toEqual([{ posProductId: 'pos-p1', quantity: 40 }]);
    expect(result.description).toContain('Supply from HQ Production');
  });

  it('applies a transfer away from this shop as stock out', () => {
    const result = movementToStockOps(
      movement({ kind: 'TRANSFER', fromShopId: 'outlet', toShopId: 'restaurant' }),
      'outlet',
      links,
    );
    expect(result.ops).toEqual([{ posProductId: 'pos-p1', quantity: -40 }]);
    expect(result.description).toContain('Transfer out to restaurant');
  });

  it('ignores movements that do not touch this shop', () => {
    const result = movementToStockOps(
      movement({ toShopId: 'restaurant' }),
      'outlet',
      links,
    );
    expect(result.relevant).toBe(false);
    expect(result.ops).toHaveLength(0);
  });

  it('surfaces unlinked products as skipped instead of losing them', () => {
    const result = movementToStockOps(
      movement({
        lines: [
          { productId: 'fin-bread', productName: 'Bread', unit: 'each', quantity: 10 },
          { productId: 'fin-mystery', productName: 'Polony', unit: 'each', quantity: 5 },
        ],
      }),
      'outlet',
      links,
    );
    expect(result.ops).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].productName).toBe('Polony');
  });
});

describe('posMovementToFinancialDoc', () => {
  const base = {
    id: 'mv-1',
    type: 'stock_in' as const,
    quantity: 25,
    datetime: '2026-08-31T22:30:00.000Z', // 00:30 next day, Lusaka time
    reason: null,
    notes: 'from Shoprite',
    productId: 'pos-p1',
    productName: 'Flour',
    unit: 'kg',
    financialId: 'fin-flour',
  };

  it('maps a stock-in to a SUPPLY purchase on the local business day', () => {
    const { docId, doc } = posMovementToFinancialDoc(base, 'outlet', 'till-1', NOW);
    expect(docId).toBe('pos-mv-1');
    expect(doc).toMatchObject({
      date: '2026-09-01',
      kind: 'SUPPLY',
      source: 'Purchase',
      fromShopId: null,
      toShopId: 'outlet',
    });
    expect(doc.lines[0]).toMatchObject({ productId: 'fin-flour', quantity: 25 });
    expect(doc.note).toContain('from Shoprite');
  });

  it('maps a stock loss to an ADHOC movement out of the shop', () => {
    const { doc } = posMovementToFinancialDoc(
      { ...base, type: 'adjustment', quantity: -3, reason: 'spoilage' },
      'outlet',
      'till-1',
      NOW,
    );
    expect(doc.kind).toBe('ADHOC');
    expect(doc.fromShopId).toBe('outlet');
    expect(doc.toShopId).toBeNull();
    expect(doc.lines[0].quantity).toBe(3);
    expect(doc.note).toContain('spoilage');
  });

  it('maps a counted stock gain to a SUPPLY (Other)', () => {
    const { doc } = posMovementToFinancialDoc(
      { ...base, type: 'adjustment', quantity: 4, reason: 'count correction' },
      'outlet',
      'till-1',
      NOW,
    );
    expect(doc.kind).toBe('SUPPLY');
    expect(doc.source).toBe('Other');
    expect(doc.toShopId).toBe('outlet');
  });

  it('falls back to the POS product id when unlinked', () => {
    const { doc } = posMovementToFinancialDoc({ ...base, financialId: null }, 'outlet', 'till-1', NOW);
    expect(doc.lines[0].productId).toBe('pos-p1');
  });
});
