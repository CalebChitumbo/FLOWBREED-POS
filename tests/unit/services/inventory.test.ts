import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices } from '../helpers/db';
import type { Services } from '../../../src/main/services';

describe('InventoryService (M4)', () => {
  let services: Services;
  let branchId: string;
  let productId: string;
  let ACTOR: string;

  beforeEach(async () => {
    services = makeServices().services;
    branchId = services.branches.getCurrentId();
    // stock_movements.user_id references users(id), so the actor must be a real user.
    ACTOR = (await services.users.create({ username: 'mgr', password: 'mgrpass1', role: 'manager' }, 'system')).id;
    productId = services.products.create(
      { name: 'Rice 5kg', category: 'Grocery', unitPrice: 12000, unitOfMeasure: 'each', lowStockThreshold: 5 },
      ACTOR,
    ).id;
  });

  it('receives stock with stockIn', () => {
    services.inventory.stockIn({ productId, branchId, quantity: 20 }, ACTOR);
    expect(services.inventory.getLevel(productId, branchId)).toBe(20);
  });

  it('rejects non-positive stock-in', () => {
    expect(() => services.inventory.stockIn({ productId, branchId, quantity: 0 }, ACTOR)).toThrow(
      /greater than zero/i,
    );
  });

  it('adjusts to an absolute counted quantity with a reason', () => {
    services.inventory.stockIn({ productId, branchId, quantity: 20 }, ACTOR);
    services.inventory.adjust({ productId, branchId, newQuantity: 18, reason: 'wastage' }, ACTOR);
    expect(services.inventory.getLevel(productId, branchId)).toBe(18);
  });

  it('requires a reason for adjustments', () => {
    expect(() =>
      services.inventory.adjust({ productId, branchId, newQuantity: 1, reason: '   ' }, ACTOR),
    ).toThrow(/reason is required/i);
  });

  it('flags low stock at or below threshold', () => {
    services.inventory.stockIn({ productId, branchId, quantity: 4 }, ACTOR); // threshold 5
    const low = services.inventory.lowStock(branchId);
    expect(low.map((l) => l.productId)).toContain(productId);
    const view = services.inventory.levels(branchId).find((l) => l.productId === productId)!;
    expect(view.isLow).toBe(true);
    expect(view.quantity).toBe(4);
  });

  it('does not flag stock above threshold', () => {
    services.inventory.stockIn({ productId, branchId, quantity: 10 }, ACTOR);
    expect(services.inventory.lowStock(branchId)).toHaveLength(0);
  });

  it('records an audit entry and last movement timestamp', () => {
    services.inventory.stockIn({ productId, branchId, quantity: 7 }, ACTOR);
    services.inventory.adjust({ productId, branchId, newQuantity: 6, reason: 'damage' }, ACTOR);
    const view = services.inventory.levels(branchId).find((l) => l.productId === productId)!;
    expect(view.lastMovement).toBeTruthy();
  });
});
