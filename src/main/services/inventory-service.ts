/**
 * Per-branch stock ledger (FI). Every quantity change is recorded as a signed
 * stock_movement AND applied to the inventory level in the SAME transaction.
 * `recordMovement` is called by SaleService inside the sale transaction; the
 * manual operations (adjust, stockIn) own their own transaction + audit entry.
 */
import type { DB } from '../db/connection';
import type { StockMovementType } from '@shared/constants';
import type { InventoryLevelView } from '@shared/types/domain';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { Errors } from '../errors';
import type { AuditService } from './audit-service';
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
    private readonly audit: AuditService,
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

  /** Receive new stock (FI-04). */
  stockIn(
    params: { productId: string; branchId: string; quantity: number; notes?: string | null },
    actorId: string,
  ): void {
    if (params.quantity <= 0) throw Errors.validation('Stock-in quantity must be greater than zero.');
    this.db.transaction(() => {
      this.recordMovement({
        productId: params.productId,
        branchId: params.branchId,
        type: 'stock_in',
        quantity: params.quantity,
        userId: actorId,
        notes: params.notes ?? null,
      });
      this.audit.record({
        userId: actorId,
        action: 'stock_in',
        entityType: 'product',
        entityId: params.productId,
        newValue: { quantity: params.quantity },
      });
    })();
  }

  /** Set stock to an absolute counted quantity with a reason (FI-03). */
  adjust(
    params: { productId: string; branchId: string; newQuantity: number; reason: string; notes?: string | null },
    actorId: string,
  ): void {
    if (!params.reason.trim()) throw Errors.validation('A reason is required for stock adjustments.');
    const current = this.getLevel(params.productId, params.branchId);
    const delta = params.newQuantity - current;
    if (delta === 0) return;
    this.db.transaction(() => {
      this.recordMovement({
        productId: params.productId,
        branchId: params.branchId,
        type: 'adjustment',
        quantity: delta,
        reason: params.reason,
        userId: actorId,
        notes: params.notes ?? null,
      });
      this.audit.record({
        userId: actorId,
        action: 'stock_adjust',
        entityType: 'product',
        entityId: params.productId,
        oldValue: { quantity: current },
        newValue: { quantity: params.newQuantity, reason: params.reason },
      });
    })();
  }

  /** Current stock for every active product at a branch, with last movement (FI-06). */
  levels(branchId: string): InventoryLevelView[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS product_id, p.name, p.category, p.unit_of_measure,
                p.low_stock_threshold, COALESCE(i.quantity, 0) AS quantity,
                (SELECT MAX(datetime) FROM stock_movements m
                   WHERE m.product_id = p.id AND m.branch_id = @branch) AS last_movement
         FROM products p
         LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = @branch
         WHERE p.active = 1
         ORDER BY p.name`,
      )
      .all({ branch: branchId }) as {
      product_id: string;
      name: string;
      category: string;
      unit_of_measure: string;
      low_stock_threshold: number;
      quantity: number;
      last_movement: string | null;
    }[];
    return rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      category: r.category,
      unitOfMeasure: r.unit_of_measure,
      quantity: r.quantity,
      lowStockThreshold: r.low_stock_threshold,
      isLow: r.low_stock_threshold > 0 && r.quantity <= r.low_stock_threshold,
      lastMovement: r.last_movement,
    }));
  }

  /** Products at or below their low-stock threshold (FI-05). */
  lowStock(branchId: string): InventoryLevelView[] {
    return this.levels(branchId).filter((l) => l.isLow);
  }
}
