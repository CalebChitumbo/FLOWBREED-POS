/**
 * Per-branch stock ledger (FI). Every quantity change is recorded as a signed
 * stock_movement AND applied to the inventory level in the SAME transaction.
 * `recordMovement` MUST be called inside a caller-owned db.transaction (e.g. the
 * sale transaction) so stock and the sale commit atomically.
 */
import type { DB } from '../db/connection';
import type { StockMovementType } from '@shared/constants';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import type { OutboxService } from './outbox-service';

export interface MovementInput {
  productId: string;
  branchId: string;
  type: StockMovementType;
  quantity: number; // signed: negative for sale, positive for stock_in/return
  reason?: string | null;
  referenceId?: string | null;
  userId: string;
  notes?: string | null;
}

export class InventoryService {
  constructor(
    private readonly db: DB,
    private readonly outbox: OutboxService,
  ) {}

  getLevel(productId: string, branchId: string): number {
    const row = this.db
      .prepare('SELECT quantity FROM inventory WHERE product_id = ? AND branch_id = ?')
      .get(productId, branchId) as { quantity: number } | undefined;
    return row?.quantity ?? 0;
  }

  /** Record a movement and apply it to the inventory level. Caller owns the txn. */
  recordMovement(input: MovementInput): void {
    const now = nowIso();
    const movementId = newId();
    this.db
      .prepare(
        `INSERT INTO stock_movements
           (id, product_id, branch_id, type, quantity, reason, reference_id, user_id, datetime, notes, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        movementId,
        input.productId,
        input.branchId,
        input.type,
        input.quantity,
        input.reason ?? null,
        input.referenceId ?? null,
        input.userId,
        now,
        input.notes ?? null,
      );
    this.outbox.enqueue('stock_movement', movementId, 'create', {
      id: movementId,
      productId: input.productId,
      branchId: input.branchId,
      type: input.type,
      quantity: input.quantity,
      datetime: now,
    });

    const inv = this.db
      .prepare('SELECT id FROM inventory WHERE product_id = ? AND branch_id = ?')
      .get(input.productId, input.branchId) as { id: string } | undefined;

    if (inv) {
      this.db
        .prepare(
          `UPDATE inventory SET quantity = quantity + ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
        )
        .run(input.quantity, now, inv.id);
      this.outbox.enqueue('inventory', inv.id, 'update', {
        id: inv.id,
        productId: input.productId,
        branchId: input.branchId,
      });
    } else {
      const invId = newId();
      this.db
        .prepare(
          `INSERT INTO inventory (id, product_id, branch_id, quantity, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
        )
        .run(invId, input.productId, input.branchId, input.quantity, now);
      this.outbox.enqueue('inventory', invId, 'create', {
        id: invId,
        productId: input.productId,
        branchId: input.branchId,
        quantity: input.quantity,
      });
    }
  }
}
