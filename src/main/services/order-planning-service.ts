/**
 * Order planning (M11).
 *
 * Two halves:
 *  1. The **order price list** (`order_catalogue`) — every item the shop buys,
 *     filed under a short CODE with its preset cost per order-unit. Changing a
 *     cost writes an append-only `order_cost_history` row (same discipline as
 *     product price_history).
 *  2. **Order plans** — the buyer types codes + quantities and the plan totals
 *     up what the order will cost. Cash taken is recorded as the `budget`; while
 *     shopping the real quantity/price per line is recorded; closing the plan
 *     freezes the actual spend and the change returned. A closed plan is a
 *     permanent record — this service refuses to edit one and the migration's
 *     triggers enforce that at the storage layer too.
 *
 * Money is INTEGER minor units (ngwee) throughout; quantities are REAL.
 */
import type { DB } from '../db/connection';
import type {
  OrderCatalogueItem,
  OrderCostHistoryEntry,
  OrderPlan,
  OrderPlanItem,
} from '@shared/types/domain';
import type { OrderPlanStatus } from '@shared/constants';
import { FINAL_ORDER_PLAN_STATUSES } from '@shared/constants';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { Errors } from '../errors';
import type { AuditService } from './audit-service';
import type { OutboxService } from './outbox-service';

// ---------------------------------------------------------------- row shapes

interface CatalogueRow {
  id: string;
  code: string;
  name: string;
  supplier: string | null;
  unit_of_order: string;
  unit_cost: number;
  pack_size: number | null;
  product_id: string | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  reference: string;
  title: string;
  branch_id: string;
  status: OrderPlanStatus;
  planned_total: number;
  budget: number | null;
  actual_total: number | null;
  change_returned: number | null;
  notes: string | null;
  created_by: string;
  created_by_name?: string;
  item_count?: number;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanItemRow {
  id: string;
  plan_id: string;
  catalogue_id: string | null;
  code: string;
  name: string;
  unit_of_order: string;
  quantity: number;
  unit_cost: number;
  line_total: number;
  actual_quantity: number | null;
  actual_unit_cost: number | null;
  actual_line_total: number | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------------- inputs

export interface CatalogueInput {
  code: string;
  name: string;
  supplier?: string | null;
  unitOfOrder: string;
  unitCost: number; // minor units
  packSize?: number | null;
  productId?: string | null;
  notes?: string | null;
}

export interface CataloguePatch {
  code?: string;
  name?: string;
  supplier?: string | null;
  unitOfOrder?: string;
  unitCost?: number;
  packSize?: number | null;
  productId?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface PlanInput {
  title: string;
  budget?: number | null;
  notes?: string | null;
}

export interface PlanPatch {
  title?: string;
  budget?: number | null;
  notes?: string | null;
}

/** Add a line by catalogue code (the normal path) or as a one-off item. */
export interface LineInput {
  code?: string;
  catalogueId?: string;
  quantity: number;
  /** Override the preset cost for this plan only (e.g. a quoted price). */
  unitCost?: number;
  /** Required for a one-off line (no code/catalogueId). */
  name?: string;
  unitOfOrder?: string;
  notes?: string | null;
  /**
   * One-off line: skip the order-list lookup entirely. `code` is then just a
   * label and `name` + `unitCost` must be supplied.
   */
  adHoc?: boolean;
}

/** `undefined` leaves a field alone; `null` clears it. */
export interface LinePatch {
  quantity?: number;
  unitCost?: number;
  actualQuantity?: number | null;
  actualUnitCost?: number | null;
  notes?: string | null;
}

export interface CloseInput {
  /** Cash actually taken, if it was not set (or changed) earlier. */
  budget?: number | null;
  /** Overrides the sum of the lines (e.g. the till slip total). */
  actualTotal?: number;
  notes?: string | null;
}

export interface PlanListFilter {
  status?: OrderPlanStatus;
  limit?: number;
}

// ------------------------------------------------------------------ mapping

function toCatalogueItem(row: CatalogueRow): OrderCatalogueItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    supplier: row.supplier,
    unitOfOrder: row.unit_of_order,
    unitCost: row.unit_cost,
    packSize: row.pack_size,
    productId: row.product_id,
    notes: row.notes,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlan(row: PlanRow): OrderPlan {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    branchId: row.branch_id,
    status: row.status,
    plannedTotal: row.planned_total,
    budget: row.budget,
    actualTotal: row.actual_total,
    changeReturned: row.change_returned,
    notes: row.notes,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: row.item_count,
  };
}

function toPlanItem(row: PlanItemRow): OrderPlanItem {
  return {
    id: row.id,
    planId: row.plan_id,
    catalogueId: row.catalogue_id,
    code: row.code,
    name: row.name,
    unitOfOrder: row.unit_of_order,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    lineTotal: row.line_total,
    actualQuantity: row.actual_quantity,
    actualUnitCost: row.actual_unit_cost,
    actualLineTotal: row.actual_line_total,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Codes are stored as typed but matched case-insensitively; keep them tidy. */
export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;

function lineTotalFor(quantity: number, unitCost: number): number {
  return Math.round(quantity * unitCost);
}

export class OrderPlanningService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ============================================================ price list

  listCatalogue(includeInactive = false): OrderCatalogueItem[] {
    const sql = includeInactive
      ? 'SELECT * FROM order_catalogue ORDER BY code'
      : 'SELECT * FROM order_catalogue WHERE active = 1 ORDER BY code';
    return (this.db.prepare(sql).all() as CatalogueRow[]).map(toCatalogueItem);
  }

  getCatalogueItem(id: string): OrderCatalogueItem | undefined {
    const row = this.db.prepare('SELECT * FROM order_catalogue WHERE id = ?').get(id) as
      | CatalogueRow
      | undefined;
    return row ? toCatalogueItem(row) : undefined;
  }

  /** The typed-code hot path: exact match on the NOCASE unique index. */
  findByCode(code: string): OrderCatalogueItem | null {
    const row = this.db
      .prepare('SELECT * FROM order_catalogue WHERE code = ? COLLATE NOCASE')
      .get(code.trim()) as CatalogueRow | undefined;
    return row ? toCatalogueItem(row) : null;
  }

  /** Type-ahead over code, name and supplier; active items only. */
  searchCatalogue(query: string): OrderCatalogueItem[] {
    const q = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM order_catalogue
         WHERE active = 1 AND (code LIKE @q OR name LIKE @q OR supplier LIKE @q)
         ORDER BY code LIMIT 50`,
      )
      .all({ q }) as CatalogueRow[];
    return rows.map(toCatalogueItem);
  }

  private assertCodeFree(code: string, exceptId?: string): void {
    const row = this.db
      .prepare('SELECT id FROM order_catalogue WHERE code = ? COLLATE NOCASE')
      .get(code) as { id: string } | undefined;
    if (row && row.id !== exceptId) {
      throw Errors.conflict(`Code "${code}" is already used by another item on the order list.`);
    }
  }

  private validateCode(code: string): string {
    const normalised = normaliseCode(code);
    if (!normalised) throw Errors.validation('An order code is required.');
    if (!CODE_PATTERN.test(normalised)) {
      throw Errors.validation(
        'An order code must be 1–16 characters: letters, numbers, dot, dash or underscore (no spaces).',
      );
    }
    return normalised;
  }

  createCatalogueItem(input: CatalogueInput, actorId: string): OrderCatalogueItem {
    const code = this.validateCode(input.code);
    const name = input.name.trim();
    if (!name) throw Errors.validation('An item name is required.');
    if (!Number.isFinite(input.unitCost) || input.unitCost < 0) {
      throw Errors.validation('The order cost cannot be negative.');
    }
    this.assertCodeFree(code);

    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO order_catalogue
             (id, code, name, supplier, unit_of_order, unit_cost, pack_size, product_id, notes,
              active, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending')`,
        )
        .run(
          id,
          code,
          name,
          input.supplier?.trim() || null,
          input.unitOfOrder,
          Math.round(input.unitCost),
          input.packSize ?? null,
          input.productId ?? null,
          input.notes?.trim() || null,
          now,
          now,
        );
      this.outbox.enqueue('order_catalogue_item', id, 'create', {
        id,
        code,
        name,
        unitCost: Math.round(input.unitCost),
      });
      this.audit.record({
        userId: actorId,
        action: 'order_item_create',
        entityType: 'order_catalogue',
        entityId: id,
        newValue: { code, name, unitCost: Math.round(input.unitCost) },
      });
    })();

    return this.getCatalogueItem(id)!;
  }

  /** Patch an item; a cost change appends an immutable order_cost_history row. */
  updateCatalogueItem(id: string, patch: CataloguePatch, actorId: string): OrderCatalogueItem {
    const existing = this.db.prepare('SELECT * FROM order_catalogue WHERE id = ?').get(id) as
      | CatalogueRow
      | undefined;
    if (!existing) throw Errors.notFound('order list item');

    const code = patch.code === undefined ? existing.code : this.validateCode(patch.code);
    if (code !== existing.code) this.assertCodeFree(code, id);

    const name = patch.name === undefined ? existing.name : patch.name.trim();
    if (!name) throw Errors.validation('An item name is required.');
    const unitCost = patch.unitCost === undefined ? existing.unit_cost : Math.round(patch.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw Errors.validation('The order cost cannot be negative.');
    }

    const next = {
      code,
      name,
      supplier: patch.supplier === undefined ? existing.supplier : patch.supplier?.trim() || null,
      unitOfOrder: patch.unitOfOrder ?? existing.unit_of_order,
      unitCost,
      packSize: patch.packSize === undefined ? existing.pack_size : patch.packSize,
      productId: patch.productId === undefined ? existing.product_id : patch.productId,
      notes: patch.notes === undefined ? existing.notes : patch.notes?.trim() || null,
      active: patch.active === undefined ? existing.active : patch.active ? 1 : 0,
    };
    const costChanged = next.unitCost !== existing.unit_cost;
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE order_catalogue
             SET code = ?, name = ?, supplier = ?, unit_of_order = ?, unit_cost = ?, pack_size = ?,
                 product_id = ?, notes = ?, active = ?, updated_at = ?, sync_status = 'pending'
           WHERE id = ?`,
        )
        .run(
          next.code,
          next.name,
          next.supplier,
          next.unitOfOrder,
          next.unitCost,
          next.packSize,
          next.productId,
          next.notes,
          next.active,
          now,
          id,
        );
      this.outbox.enqueue('order_catalogue_item', id, 'update', {
        id,
        code: next.code,
        name: next.name,
        unitCost: next.unitCost,
      });

      if (costChanged) {
        const historyId = newId();
        this.db
          .prepare(
            `INSERT INTO order_cost_history (id, catalogue_id, old_cost, new_cost, changed_by, datetime)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(historyId, id, existing.unit_cost, next.unitCost, actorId, now);
        this.outbox.enqueue('order_cost_history', historyId, 'create', {
          id: historyId,
          catalogueId: id,
          oldCost: existing.unit_cost,
          newCost: next.unitCost,
          changedBy: actorId,
          datetime: now,
        });
        this.audit.record({
          userId: actorId,
          action: 'order_cost_change',
          entityType: 'order_catalogue',
          entityId: id,
          oldValue: { unitCost: existing.unit_cost },
          newValue: { unitCost: next.unitCost },
        });
      }

      this.audit.record({
        userId: actorId,
        action: 'order_item_update',
        entityType: 'order_catalogue',
        entityId: id,
        newValue: { code: next.code, name: next.name, active: next.active },
      });
    })();

    return this.getCatalogueItem(id)!;
  }

  costHistory(catalogueId: string): OrderCostHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM order_cost_history WHERE catalogue_id = ? ORDER BY datetime DESC')
      .all(catalogueId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      catalogueId: r.catalogue_id as string,
      oldCost: r.old_cost as number,
      newCost: r.new_cost as number,
      changedBy: r.changed_by as string,
      datetime: r.datetime as string,
    }));
  }

  // ================================================================== plans

  private nextReference(branchId: string): string {
    const seq =
      (
        this.db.prepare('SELECT count(*) AS c FROM order_plans WHERE branch_id = ?').get(branchId) as {
          c: number;
        }
      ).c + 1;
    return `ORD-${branchId.slice(0, 4).toUpperCase()}-${String(seq).padStart(5, '0')}`;
  }

  private planRow(id: string): PlanRow {
    const row = this.db.prepare('SELECT * FROM order_plans WHERE id = ?').get(id) as PlanRow | undefined;
    if (!row) throw Errors.notFound('order plan');
    return row;
  }

  /** Guard every mutation: a closed or cancelled plan is a permanent record. */
  private assertEditable(row: PlanRow): void {
    if (FINAL_ORDER_PLAN_STATUSES.includes(row.status)) {
      throw Errors.conflict(
        `Order plan ${row.reference} is ${row.status} and can no longer be changed. Duplicate it to start a new plan.`,
      );
    }
  }

  private lineRow(id: string): PlanItemRow {
    const row = this.db.prepare('SELECT * FROM order_plan_items WHERE id = ?').get(id) as
      | PlanItemRow
      | undefined;
    if (!row) throw Errors.notFound('order line');
    return row;
  }

  /** Re-sum the plan from its lines. Caller owns the transaction. */
  private recalcPlan(planId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE order_plans
            SET planned_total = (SELECT COALESCE(SUM(line_total), 0) FROM order_plan_items WHERE plan_id = ?),
                updated_at = ?, sync_status = 'pending'
          WHERE id = ?`,
      )
      .run(planId, now, planId);
    this.outbox.enqueue('order_plan', planId, 'update', { id: planId });
  }

  listPlans(branchId: string, filter: PlanListFilter = {}): OrderPlan[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT p.*, u.username AS created_by_name,
                (SELECT count(*) FROM order_plan_items i WHERE i.plan_id = p.id) AS item_count
           FROM order_plans p
           LEFT JOIN users u ON u.id = p.created_by
          WHERE p.branch_id = @branch AND (@status IS NULL OR p.status = @status)
          ORDER BY p.created_at DESC, p.reference DESC
          LIMIT @limit`,
      )
      .all({ branch: branchId, status: filter.status ?? null, limit }) as PlanRow[];
    return rows.map(toPlan);
  }

  items(planId: string): OrderPlanItem[] {
    const rows = this.db
      .prepare('SELECT * FROM order_plan_items WHERE plan_id = ? ORDER BY sort_order, created_at')
      .all(planId) as PlanItemRow[];
    return rows.map(toPlanItem);
  }

  getPlan(id: string): OrderPlan {
    const row = this.db
      .prepare(
        `SELECT p.*, u.username AS created_by_name FROM order_plans p
         LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`,
      )
      .get(id) as PlanRow | undefined;
    if (!row) throw Errors.notFound('order plan');
    const plan = toPlan(row);
    plan.items = this.items(id);
    plan.itemCount = plan.items.length;
    return plan;
  }

  createPlan(input: PlanInput, branchId: string, actorId: string): OrderPlan {
    const title = input.title.trim();
    if (!title) throw Errors.validation('Give the order plan a name, e.g. "Friday market run".');
    if (input.budget != null && input.budget < 0) throw Errors.validation('The budget cannot be negative.');

    const id = newId();
    const now = nowIso();
    const reference = this.nextReference(branchId);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO order_plans
             (id, reference, title, branch_id, status, planned_total, budget, notes,
              created_by, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          id,
          reference,
          title,
          branchId,
          input.budget == null ? null : Math.round(input.budget),
          input.notes?.trim() || null,
          actorId,
          now,
          now,
        );
      this.outbox.enqueue('order_plan', id, 'create', { id, reference, title, branchId });
      this.audit.record({
        userId: actorId,
        action: 'order_plan_create',
        entityType: 'order_plan',
        entityId: id,
        newValue: { reference, title, budget: input.budget ?? null },
      });
    })();

    return this.getPlan(id);
  }

  updatePlan(id: string, patch: PlanPatch, actorId: string): OrderPlan {
    const existing = this.planRow(id);
    this.assertEditable(existing);

    const title = patch.title === undefined ? existing.title : patch.title.trim();
    if (!title) throw Errors.validation('The order plan needs a name.');
    const budget = patch.budget === undefined ? existing.budget : patch.budget == null ? null : Math.round(patch.budget);
    if (budget != null && budget < 0) throw Errors.validation('The budget cannot be negative.');
    const notes = patch.notes === undefined ? existing.notes : patch.notes?.trim() || null;
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE order_plans SET title = ?, budget = ?, notes = ?, updated_at = ?, sync_status = 'pending'
            WHERE id = ?`,
        )
        .run(title, budget, notes, now, id);
      this.outbox.enqueue('order_plan', id, 'update', { id, title, budget });
      this.audit.record({
        userId: actorId,
        action: 'order_plan_update',
        entityType: 'order_plan',
        entityId: id,
        oldValue: { title: existing.title, budget: existing.budget },
        newValue: { title, budget },
      });
    })();

    return this.getPlan(id);
  }

  /** Add a line — normally "code + quantity", the whole point of the tab. */
  addLine(planId: string, input: LineInput, actorId: string): OrderPlan {
    const plan = this.planRow(planId);
    this.assertEditable(plan);
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw Errors.validation('Quantity must be greater than zero.');
    }

    let catalogueItem: OrderCatalogueItem | null = null;
    if (input.catalogueId) {
      catalogueItem = this.getCatalogueItem(input.catalogueId) ?? null;
      if (!catalogueItem) throw Errors.notFound('order list item');
    } else if (!input.adHoc && input.code?.trim()) {
      catalogueItem = this.findByCode(input.code);
      if (!catalogueItem) {
        throw Errors.notFound(`item with code "${normaliseCode(input.code)}" — add it to the order list first`);
      }
    }

    const name = (catalogueItem?.name ?? input.name ?? '').trim();
    if (!name) throw Errors.validation('Enter a code from the order list, or a name for a one-off item.');
    const unitCost = Math.round(input.unitCost ?? catalogueItem?.unitCost ?? 0);
    if (!Number.isFinite(unitCost) || unitCost < 0) throw Errors.validation('The cost cannot be negative.');

    const code = catalogueItem?.code ?? (input.code ? normaliseCode(input.code) : '—');
    const unitOfOrder = catalogueItem?.unitOfOrder ?? input.unitOfOrder ?? 'each';
    const id = newId();
    const now = nowIso();
    const total = lineTotalFor(input.quantity, unitCost);
    const nextSort =
      ((
        this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM order_plan_items WHERE plan_id = ?').get(planId) as {
          m: number;
        }
      ).m ?? 0) + 1;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO order_plan_items
             (id, plan_id, catalogue_id, code, name, unit_of_order, quantity, unit_cost, line_total,
              notes, sort_order, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          id,
          planId,
          catalogueItem?.id ?? null,
          code,
          name,
          unitOfOrder,
          input.quantity,
          unitCost,
          total,
          input.notes?.trim() || null,
          nextSort,
          now,
          now,
        );
      this.outbox.enqueue('order_plan_item', id, 'create', {
        id,
        planId,
        code,
        quantity: input.quantity,
        unitCost,
        lineTotal: total,
      });
      this.audit.record({
        userId: actorId,
        action: 'order_line_add',
        entityType: 'order_plan',
        entityId: planId,
        newValue: { code, name, quantity: input.quantity, unitCost, lineTotal: total },
      });
      this.recalcPlan(planId);
    })();

    return this.getPlan(planId);
  }

  /** Edit a planned line, or record what it actually cost while shopping. */
  updateLine(lineId: string, patch: LinePatch, actorId: string): OrderPlan {
    const line = this.lineRow(lineId);
    const plan = this.planRow(line.plan_id);
    this.assertEditable(plan);

    const quantity = patch.quantity === undefined ? line.quantity : patch.quantity;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw Errors.validation('Quantity must be greater than zero.');
    }
    const unitCost = patch.unitCost === undefined ? line.unit_cost : Math.round(patch.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) throw Errors.validation('The cost cannot be negative.');

    const actualQuantity =
      patch.actualQuantity === undefined ? line.actual_quantity : patch.actualQuantity;
    const actualUnitCost =
      patch.actualUnitCost === undefined
        ? line.actual_unit_cost
        : patch.actualUnitCost == null
          ? null
          : Math.round(patch.actualUnitCost);
    if (actualQuantity != null && (!Number.isFinite(actualQuantity) || actualQuantity < 0)) {
      throw Errors.validation('The actual quantity cannot be negative.');
    }
    if (actualUnitCost != null && (!Number.isFinite(actualUnitCost) || actualUnitCost < 0)) {
      throw Errors.validation('The actual cost cannot be negative.');
    }

    // Blank actuals mean "it went as planned"; either one filled in prices the line.
    const actualLineTotal =
      actualQuantity == null && actualUnitCost == null
        ? null
        : lineTotalFor(actualQuantity ?? quantity, actualUnitCost ?? unitCost);
    const notes = patch.notes === undefined ? line.notes : patch.notes?.trim() || null;
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE order_plan_items
              SET quantity = ?, unit_cost = ?, line_total = ?, actual_quantity = ?, actual_unit_cost = ?,
                  actual_line_total = ?, notes = ?, updated_at = ?, sync_status = 'pending'
            WHERE id = ?`,
        )
        .run(
          quantity,
          unitCost,
          lineTotalFor(quantity, unitCost),
          actualQuantity,
          actualUnitCost,
          actualLineTotal,
          notes,
          now,
          lineId,
        );
      this.outbox.enqueue('order_plan_item', lineId, 'update', {
        id: lineId,
        planId: line.plan_id,
        quantity,
        unitCost,
        actualLineTotal,
      });
      this.audit.record({
        userId: actorId,
        action: 'order_line_update',
        entityType: 'order_plan',
        entityId: line.plan_id,
        oldValue: { code: line.code, quantity: line.quantity, lineTotal: line.line_total },
        newValue: { quantity, unitCost, actualLineTotal },
      });
      this.recalcPlan(line.plan_id);
    })();

    return this.getPlan(line.plan_id);
  }

  removeLine(lineId: string, actorId: string): OrderPlan {
    const line = this.lineRow(lineId);
    const plan = this.planRow(line.plan_id);
    this.assertEditable(plan);

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM order_plan_items WHERE id = ?').run(lineId);
      this.outbox.enqueue('order_plan_item', lineId, 'delete', { id: lineId, planId: line.plan_id });
      this.audit.record({
        userId: actorId,
        action: 'order_line_remove',
        entityType: 'order_plan',
        entityId: line.plan_id,
        oldValue: { code: line.code, quantity: line.quantity, lineTotal: line.line_total },
      });
      this.recalcPlan(line.plan_id);
    })();

    return this.getPlan(line.plan_id);
  }

  /** What the plan has actually cost so far (lines without actuals count as planned). */
  actualSoFar(planId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(actual_line_total, line_total)), 0) AS total
           FROM order_plan_items WHERE plan_id = ?`,
      )
      .get(planId) as { total: number };
    return Math.round(row.total);
  }

  /** draft <-> shopping, or cancel. Closing goes through `closePlan`. */
  setStatus(planId: string, status: OrderPlanStatus, actorId: string): OrderPlan {
    const plan = this.planRow(planId);
    this.assertEditable(plan);
    if (status === 'closed') {
      throw Errors.validation('Use "Close & reconcile" to finish an order plan.');
    }
    if (status === plan.status) return this.getPlan(planId);

    const now = nowIso();
    this.db.transaction(() => {
      if (status === 'cancelled') {
        this.db
          .prepare(
            `UPDATE order_plans SET status = 'cancelled', closed_by = ?, closed_at = ?, updated_at = ?,
                 sync_status = 'pending' WHERE id = ?`,
          )
          .run(actorId, now, now, planId);
      } else {
        this.db
          .prepare(`UPDATE order_plans SET status = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`)
          .run(status, now, planId);
      }
      this.outbox.enqueue('order_plan', planId, 'update', { id: planId, status });
      this.audit.record({
        userId: actorId,
        action: 'order_plan_status',
        entityType: 'order_plan',
        entityId: planId,
        oldValue: { status: plan.status },
        newValue: { status },
      });
    })();

    return this.getPlan(planId);
  }

  /**
   * Freeze the plan: record what was really spent and the change handed back
   * (budget - actual). After this the plan is a permanent record.
   */
  closePlan(planId: string, input: CloseInput, actorId: string): OrderPlan {
    const plan = this.planRow(planId);
    this.assertEditable(plan);
    const lineCount = (
      this.db.prepare('SELECT count(*) AS c FROM order_plan_items WHERE plan_id = ?').get(planId) as {
        c: number;
      }
    ).c;
    if (lineCount === 0) throw Errors.validation('Add at least one item before closing the plan.');

    const budget =
      input.budget === undefined ? plan.budget : input.budget == null ? null : Math.round(input.budget);
    if (budget != null && budget < 0) throw Errors.validation('The cash taken cannot be negative.');

    const actualTotal =
      input.actualTotal === undefined ? this.actualSoFar(planId) : Math.round(input.actualTotal);
    if (!Number.isFinite(actualTotal) || actualTotal < 0) {
      throw Errors.validation('The amount spent cannot be negative.');
    }
    const changeReturned = budget == null ? null : budget - actualTotal;
    const notes = input.notes === undefined ? plan.notes : input.notes?.trim() || null;
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE order_plans
              SET status = 'closed', budget = ?, actual_total = ?, change_returned = ?, notes = ?,
                  closed_by = ?, closed_at = ?, updated_at = ?, sync_status = 'pending'
            WHERE id = ?`,
        )
        .run(budget, actualTotal, changeReturned, notes, actorId, now, now, planId);
      this.outbox.enqueue('order_plan', planId, 'update', {
        id: planId,
        status: 'closed',
        actualTotal,
        changeReturned,
      });
      this.audit.record({
        userId: actorId,
        action: 'order_plan_close',
        entityType: 'order_plan',
        entityId: planId,
        oldValue: { plannedTotal: plan.planned_total, budget: plan.budget },
        newValue: { actualTotal, changeReturned, budget },
      });
    })();

    return this.getPlan(planId);
  }

  /**
   * Copy a plan into a fresh draft, re-priced at today's costs — the fast way to
   * repeat a standing weekly order (and the way to correct a closed one).
   */
  duplicatePlan(planId: string, branchId: string, actorId: string, title?: string): OrderPlan {
    const source = this.getPlan(planId);
    const lines = source.items ?? [];
    if (!lines.length) throw Errors.validation('That plan has no items to copy.');

    const created = this.createPlan(
      {
        title: title?.trim() || `${source.title} (copy)`,
        budget: source.budget,
        notes: source.notes,
      },
      branchId,
      actorId,
    );

    for (const line of lines) {
      // Re-price from the live order list where the item is still on it; items
      // that have since been retired are copied across as one-off lines.
      const current = line.catalogueId ? this.getCatalogueItem(line.catalogueId) : undefined;
      const live = current?.active ? current : undefined;
      this.addLine(
        created.id,
        live
          ? { catalogueId: live.id, quantity: line.quantity, notes: line.notes }
          : {
              adHoc: true,
              code: line.code,
              name: line.name,
              unitOfOrder: line.unitOfOrder,
              quantity: line.quantity,
              unitCost: line.unitCost,
              notes: line.notes,
            },
        actorId,
      );
    }

    return this.getPlan(created.id);
  }
}
