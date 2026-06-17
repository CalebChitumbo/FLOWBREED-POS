/** Inventory IPC handlers (M4). Manager/administrator only. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';

const tokenStr = z.string().min(1);

export function registerInventoryHandlers(): void {
  registerHandler('inventory:levels', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, inventory, branches } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return inventory.levels(branches.getCurrentId());
  });

  registerHandler('inventory:lowStock', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, inventory, branches } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return inventory.lowStock(branches.getCurrentId());
  });

  registerHandler('inventory:stockIn', (req) => {
    const { token, productId, quantity, notes } = z
      .object({
        token: tokenStr,
        productId: z.string().min(1),
        quantity: z.number().positive(),
        notes: z.string().max(200).nullish(),
      })
      .parse(req);
    const { sessions, inventory, branches } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    inventory.stockIn({ productId, branchId: branches.getCurrentId(), quantity, notes }, session.userId);
    return { ok: true as const };
  });

  registerHandler('inventory:adjust', (req) => {
    const { token, productId, newQuantity, reason, notes } = z
      .object({
        token: tokenStr,
        productId: z.string().min(1),
        newQuantity: z.number().min(0),
        reason: z.string().min(1).max(120),
        notes: z.string().max(200).nullish(),
      })
      .parse(req);
    const { sessions, inventory, branches } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    inventory.adjust(
      { productId, branchId: branches.getCurrentId(), newQuantity, reason, notes },
      session.userId,
    );
    return { ok: true as const };
  });
}
