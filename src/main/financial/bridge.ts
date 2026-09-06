/**
 * FinancialBridge — the two-way link between this till and the Flowbreeds
 * Financial app (the Firebase bookkeeping app), so the books and the shop floor
 * stop being two systems that meet in a phone call. Four flows per run:
 *
 *  1. PULL catalogue   — the Financial app's products become/refresh local POS
 *                        products (LWW on the app's write stamps), linked via
 *                        products.financial_id, with price changes logged to
 *                        price_history. Prices are managed once, centrally.
 *  2. APPLY deliveries — HQ-recorded stock movements (SUPPLY/TRANSFER touching
 *                        this shop) land on local inventory exactly once, via
 *                        the finhub_applied_movements ledger.
 *  3. PUSH sales       — every business day of till activity becomes ONE
 *                        shopSales doc (source 'POS', deterministic id), so a
 *                        re-push corrects the day and can never duplicate it.
 *                        Days are re-pushed whenever their transactions change
 *                        (a late refund or void self-heals the day's doc).
 *  4. PUSH stock       — locally received stock and count adjustments go up as
 *                        Financial stockMovements, so the app's derived
 *                        stock-on-hand keeps step with the shelf. Movements the
 *                        bridge itself applied in flow 2 are marked and never
 *                        echoed back.
 *
 * Everything is idempotent and re-runnable: deterministic doc ids, high-water
 *  marks that only advance after a fully successful flow, and an applied-ledger
 * for inbound movements. No Electron imports — unit-tested against a fake
 * FinancialStore in tests/unit/financial.
 */
import type { DB } from '../db/connection';
import type { ConfigService } from '../services/config-service';
import type { InventoryService } from '../services/inventory-service';
import type { BranchService } from '../services/branch-service';
import type { AuditService } from '../services/audit-service';
import type { OutboxService } from '../services/outbox-service';
import type { FinhubRunResult } from '@shared/ipc/contract';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { toMinor } from '@shared/money';
import { FINHUB_KEYS } from './keys';
import type { FinancialProductDoc, FinancialStore } from './types';
import {
  FINHUB_REF_PREFIX,
  buildShopSaleDoc,
  movementToStockOps,
  posMovementToFinancialDoc,
  saleDocId,
  sqlBusinessDayModifier,
  type DayLineAgg,
  type PosMovementForPush,
} from './mapping';

const SYSTEM_USERNAME = 'financial-hub';
/** Sentinel mark after a successful full first scan that saw no stamped docs. */
const EPOCH = '1970-01-01T00:00:00.000Z';

export interface BridgeSettings {
  shopId: string | null;
  terminalId: string;
  pullCatalogue: boolean;
  applyDeliveries: boolean;
  pushStock: boolean;
}

export interface BridgeDeps {
  db: DB;
  config: ConfigService;
  store: FinancialStore;
  branches: BranchService;
  inventory: InventoryService;
  audit: AuditService;
  outbox: OutboxService;
}

/** Current bridge settings (toggles default ON; terminal id minted on first read). */
export function readBridgeSettings(config: ConfigService, branches: BranchService): BridgeSettings {
  let terminalId = config.get(FINHUB_KEYS.terminalId);
  if (!terminalId) {
    terminalId = `pos-${branches.getCurrentId().slice(0, 8)}`;
    config.set(FINHUB_KEYS.terminalId, terminalId);
  }
  const flag = (key: string): boolean => config.get(key) !== '0';
  return {
    shopId: config.get(FINHUB_KEYS.shopId) || null,
    terminalId,
    pullCatalogue: flag(FINHUB_KEYS.pullCatalogue),
    applyDeliveries: flag(FINHUB_KEYS.applyDeliveries),
    pushStock: flag(FINHUB_KEYS.pushStock),
  };
}

export class FinancialBridge {
  private running = false;

  constructor(private readonly deps: BridgeDeps) {}

  settings(): BridgeSettings {
    return readBridgeSettings(this.deps.config, this.deps.branches);
  }

  /** One full bridge cycle. Never throws — problems land in result.errors. */
  async run(): Promise<FinhubRunResult> {
    const result: FinhubRunResult = {
      ranAt: nowIso(),
      pushedSaleDays: [],
      pushedMovements: 0,
      pulledProducts: 0,
      appliedMovements: 0,
      warnings: [],
      errors: [],
    };
    if (this.running) {
      result.warnings.push('A sync was already running; skipped this cycle.');
      return result;
    }
    this.running = true;
    try {
      const settings = this.settings();
      if (!settings.shopId) {
        result.errors.push(
          'Choose which Financial-app shop this branch posts to (Settings → Financial Hub).',
        );
        return result;
      }
      const shopId = settings.shopId;

      // Order matters: links first, then stock in, then money out.
      if (settings.pullCatalogue) {
        await this.guard(result, 'Catalogue pull', () => this.pullCatalogue(shopId, result));
      }
      if (settings.applyDeliveries) {
        await this.guard(result, 'Deliveries', () => this.applyDeliveries(shopId, result));
      }
      await this.guard(result, 'Sales push', () =>
        this.pushSales(shopId, settings.terminalId, result),
      );
      if (settings.pushStock) {
        await this.guard(result, 'Stock push', () =>
          this.pushStock(shopId, settings.terminalId, result),
        );
      }
      return result;
    } finally {
      this.running = false;
      this.deps.config.set(FINHUB_KEYS.lastRunAt, result.ranAt);
      this.deps.config.setJson(FINHUB_KEYS.lastRunSummary, result);
    }
  }

  private async guard(result: FinhubRunResult, label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------------------------------------------------------------------
  // Flow 1 — Financial catalogue -> local products (LWW, linked by id)
  // ------------------------------------------------------------------

  private async pullCatalogue(shopId: string, result: FinhubRunResult): Promise<void> {
    const { config, store } = this.deps;
    const since = config.get(FINHUB_KEYS.lastProductPullAt);
    const products = await store.listProducts(since || null);
    let mark = since || EPOCH;

    for (const fp of products) {
      if (this.applyFinancialProduct(fp, shopId, result)) result.pulledProducts += 1;
      if (fp.updatedAt && fp.updatedAt > mark) mark = fp.updatedAt;
    }
    config.set(FINHUB_KEYS.lastProductPullAt, mark);
  }

  /** Returns true when the local catalogue changed. */
  private applyFinancialProduct(
    fp: FinancialProductDoc & { id: string },
    shopId: string,
    result: FinhubRunResult,
  ): boolean {
    const { db, outbox } = this.deps;
    const now = nowIso();
    const soldHere = Array.isArray(fp.shopIds) && fp.shopIds.includes(shopId);

    let local = db.prepare('SELECT * FROM products WHERE financial_id = ?').get(fp.id) as
      | Record<string, unknown>
      | undefined;

    // Auto-link by name so a catalogue that was typed into both systems
    // converges instead of duplicating.
    if (!local && fp.name) {
      const byName = db
        .prepare('SELECT * FROM products WHERE financial_id IS NULL AND lower(name) = lower(?)')
        .get(fp.name.trim()) as Record<string, unknown> | undefined;
      if (byName) {
        db.prepare('UPDATE products SET financial_id = ? WHERE id = ?').run(fp.id, byName.id);
        local = { ...byName, financial_id: fp.id };
        result.warnings.push(`Linked existing product "${fp.name}" to the Financial catalogue.`);
      }
    }

    if (!local) {
      if (!soldHere || !fp.active) return false; // not for this shop — don't import
      const id = newId();
      const priceNgwee = toMinor(Number(fp.retailPrice) || 0);
      db.transaction(() => {
        db.prepare(
          `INSERT INTO products
             (id, name, category, unit_price, unit_of_measure, is_weight_based, low_stock_threshold,
              active, financial_id, created_at, updated_at, sync_status)
           VALUES (?, ?, 'Grocery', ?, ?, ?, 0, 1, ?, ?, ?, 'pending')`,
        ).run(id, fp.name, priceNgwee, fp.unit || 'each', fp.unit === 'kg' ? 1 : 0, fp.id, now, now);
        outbox.enqueue('product', id, 'create', { id, name: fp.name, financialId: fp.id });
      })();
      return true;
    }

    // Linked product no longer sold here / withdrawn centrally -> deactivate.
    if (!soldHere || !fp.active) {
      if (Number(local.active) === 0) return false;
      db.transaction(() => {
        db.prepare(
          `UPDATE products SET active = 0, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
        ).run(now, local.id);
        outbox.enqueue('product', String(local.id), 'update', { id: local.id, active: false });
      })();
      result.warnings.push(`"${String(local.name)}" was withdrawn in the Financial catalogue — deactivated here.`);
      return true;
    }

    // Last-Write-Wins on the Financial write stamp: local edits made after the
    // Financial edit stand; otherwise the central catalogue is authoritative.
    if (!fp.updatedAt || fp.updatedAt <= String(local.updated_at)) return false;

    const priceNgwee = toMinor(Number(fp.retailPrice) || 0);
    const oldPrice = Number(local.unit_price);
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET name = ?, unit_of_measure = ?, unit_price = ?, active = 1,
           updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      ).run(fp.name, fp.unit || String(local.unit_of_measure), priceNgwee, now, local.id);
      outbox.enqueue('product', String(local.id), 'update', {
        id: local.id,
        name: fp.name,
        unitPrice: priceNgwee,
      });
      if (priceNgwee !== oldPrice) {
        const phId = newId();
        db.prepare(
          `INSERT INTO price_history (id, product_id, old_price, new_price, changed_by, datetime)
           VALUES (?, ?, ?, ?, 'financial-hub', ?)`,
        ).run(phId, local.id, oldPrice, priceNgwee, now);
        outbox.enqueue('price_history', phId, 'create', {
          id: phId,
          productId: local.id,
          oldPrice,
          newPrice: priceNgwee,
          changedBy: 'financial-hub',
          datetime: now,
        });
      }
    })();
    return true;
  }

  // ------------------------------------------------------------------
  // Flow 2 — HQ deliveries -> local inventory (exactly once)
  // ------------------------------------------------------------------

  private async applyDeliveries(shopId: string, result: FinhubRunResult): Promise<void> {
    const { db, config, store, inventory, branches, audit } = this.deps;
    const since = config.get(FINHUB_KEYS.lastMovementPullAt);
    // First connection: the Financial app's delivery HISTORY must not replay
    // onto this till's shelf count — those goods have long since been sold,
    // and the offsetting sales are not in this till either. Historic movements
    // are ledgered as "grandfathered" so they can never apply later; only
    // deliveries recorded from connection day onward move local stock. The
    // till's opening truth is a physical count (Inventory → Adjust).
    const firstRun = !since;
    const movements = await store.listStockMovements(since || null);
    if (movements.length === 0) {
      if (firstRun) config.set(FINHUB_KEYS.lastMovementPullAt, EPOCH);
      return;
    }

    const branchId = branches.getCurrentId();
    const links = new Map<string, string>(
      (db.prepare('SELECT id, financial_id FROM products WHERE financial_id IS NOT NULL').all() as {
        id: string;
        financial_id: string;
      }[]).map((r) => [r.financial_id, r.id]),
    );
    const systemUserId = this.ensureSystemUser();
    let mark = since || EPOCH;
    let grandfathered = 0;

    for (const mv of movements) {
      if (mv.updatedAt && mv.updatedAt > mark) mark = mv.updatedAt;

      const applied = db
        .prepare('SELECT applied_at FROM finhub_applied_movements WHERE movement_id = ?')
        .get(mv.id) as { applied_at: string } | undefined;
      const application = movementToStockOps(mv, shopId, links);
      if (!application.relevant) continue;

      if (firstRun) {
        if (!applied) {
          db.prepare(
            `INSERT INTO finhub_applied_movements (movement_id, applied_at, summary) VALUES (?, ?, ?)`,
          ).run(mv.id, nowIso(), 'From before this till was connected — noted, not applied to stock');
          grandfathered += 1;
        }
        continue;
      }

      if (applied) {
        // It changed at HQ after we applied it — we can't safely re-apply.
        result.warnings.push(
          `Delivery ${mv.id} (${mv.date}) was edited in the Financial app after it was applied here on ${applied.applied_at.slice(0, 10)} — check stock manually.`,
        );
        continue;
      }

      db.transaction(() => {
        for (const op of application.ops) {
          inventory.recordMovement({
            productId: op.posProductId,
            branchId,
            type: op.quantity >= 0 ? 'stock_in' : 'adjustment',
            quantity: op.quantity,
            reason: application.description,
            referenceId: `${FINHUB_REF_PREFIX}${mv.id}`,
            userId: systemUserId,
            notes: mv.note || null,
          });
        }
        db.prepare(
          `INSERT INTO finhub_applied_movements (movement_id, applied_at, summary) VALUES (?, ?, ?)`,
        ).run(
          mv.id,
          nowIso(),
          `${application.description}: ${application.ops.length} line(s) applied, ${application.skipped.length} skipped`,
        );
        audit.record({
          userId: systemUserId,
          action: 'finhub_delivery_applied',
          entityType: 'stock_movement',
          entityId: mv.id,
          newValue: { date: mv.date, kind: mv.kind, lines: application.ops.length },
        });
      })();
      result.appliedMovements += 1;

      for (const skip of application.skipped) {
        result.warnings.push(
          `Delivery ${mv.date}: line "${skip.productName}" × ${skip.quantity} skipped — ${skip.reason}.`,
        );
      }
    }
    if (grandfathered > 0) {
      result.warnings.push(
        `${grandfathered} delivery record(s) from before this till was connected were noted but NOT applied to its stock. Count the shelves and set opening quantities with Inventory → Adjust; from now on new deliveries apply automatically.`,
      );
    }
    config.set(FINHUB_KEYS.lastMovementPullAt, mark);
  }

  /** Actor for bridge-made inventory writes: a disabled, unmistakable user. */
  private ensureSystemUser(): string {
    const { db } = this.deps;
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(SYSTEM_USERNAME) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at, sync_status)
       VALUES (?, ?, 'disabled:financial-hub', 'manager', 0, ?, ?, 'synced')`,
    ).run(id, SYSTEM_USERNAME, now, now);
    return id;
  }

  // ------------------------------------------------------------------
  // Flow 3 — till days -> Financial shopSales (one doc per business day)
  // ------------------------------------------------------------------

  private async pushSales(shopId: string, terminalId: string, result: FinhubRunResult): Promise<void> {
    const { db, config, store, branches } = this.deps;
    const branchId = branches.getCurrentId();
    const branchName = branches.getCurrent().name;
    const modifier = sqlBusinessDayModifier();
    const queryStart = nowIso();
    const sinceMark = config.get(FINHUB_KEYS.lastSaleSyncAt) ?? '';

    // Any transaction touched since the mark re-aggregates its WHOLE business
    // day (voids and late refunds self-heal the day's doc). Inclusive compare:
    // a write in the same millisecond as the mark re-pushes once (idempotent)
    // instead of being skipped forever.
    const days = (
      db
        .prepare(
          `SELECT DISTINCT date(datetime, ?) AS day FROM transactions
           WHERE branch_id = ? AND updated_at >= ? ORDER BY day`,
        )
        .all(modifier, branchId, sinceMark) as { day: string }[]
    ).map((r) => r.day);
    if (days.length === 0) {
      // Still advance the mark: a txn stamped exactly at the old mark has been
      // (re-)pushed by now and must not match forever.
      config.set(FINHUB_KEYS.lastSaleSyncAt, queryStart);
      return;
    }

    const linkRows = db
      .prepare('SELECT id, financial_id FROM products WHERE financial_id IS NOT NULL')
      .all() as { id: string; financial_id: string }[];
    const financialIdByProduct = new Map(linkRows.map((r) => [r.id, r.financial_id]));

    for (const day of days) {
      const rows = db
        .prepare(
          `SELECT i.product_id AS productId, i.product_name AS productName,
                  p.unit_of_measure AS unit, i.unit_price_at_sale AS unitPriceNgwee,
                  t.type AS txnType,
                  SUM(i.quantity) AS quantity,
                  SUM(i.line_total + i.line_discount) AS grossNgwee
           FROM transactions t
           JOIN transaction_items i ON i.transaction_id = t.id
           JOIN products p ON p.id = i.product_id
           WHERE t.status = 'completed' AND t.branch_id = ? AND date(t.datetime, ?) = ?
           GROUP BY i.product_id, i.product_name, p.unit_of_measure, i.unit_price_at_sale, t.type`,
        )
        .all(branchId, modifier, day) as DayLineAgg[];

      const totals = db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN type = 'sale' THEN discount_total ELSE 0 END), 0) AS discounts,
                  COALESCE(SUM(CASE WHEN type = 'sale' THEN 1 ELSE 0 END), 0) AS sales,
                  COALESCE(SUM(CASE WHEN type = 'refund' THEN 1 ELSE 0 END), 0) AS refunds
           FROM transactions
           WHERE status = 'completed' AND branch_id = ? AND date(datetime, ?) = ?`,
        )
        .get(branchId, modifier, day) as { discounts: number; sales: number; refunds: number };

      const doc = buildShopSaleDoc({
        date: day,
        shopId,
        terminalId,
        branchName,
        rows,
        saleDiscountNgwee: totals.discounts,
        saleCount: totals.sales,
        refundCount: totals.refunds,
        financialIdByProduct,
        nowIso: nowIso(),
      });
      await store.upsertShopSale(saleDocId(day, shopId, terminalId), doc);
      result.pushedSaleDays.push(day);
    }

    // Advance only after every changed day landed; writes made during the run
    // carry later updated_at stamps and re-push (idempotently) next cycle.
    config.set(FINHUB_KEYS.lastSaleSyncAt, queryStart);
  }

  // ------------------------------------------------------------------
  // Flow 4 — local stock receipts/adjustments -> Financial stockMovements
  // ------------------------------------------------------------------

  private async pushStock(shopId: string, terminalId: string, result: FinhubRunResult): Promise<void> {
    const { db, config, store, branches } = this.deps;
    const branchId = branches.getCurrentId();
    const queryStart = nowIso();
    const sinceMark = config.get(FINHUB_KEYS.lastStockPushAt) ?? '';

    const rows = db
      .prepare(
        `SELECT m.id, m.type, m.quantity, m.datetime, m.reason, m.notes,
                m.product_id AS productId, p.name AS productName,
                p.unit_of_measure AS unit, p.financial_id AS financialId
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         WHERE m.branch_id = ? AND m.datetime >= ?
           AND m.type IN ('stock_in', 'adjustment')
           AND (m.reference_id IS NULL OR m.reference_id NOT LIKE ?)
         ORDER BY m.datetime`,
      )
      .all(branchId, sinceMark, `${FINHUB_REF_PREFIX}%`) as PosMovementForPush[];

    for (const row of rows) {
      const { docId, doc } = posMovementToFinancialDoc(row, shopId, terminalId, nowIso());
      await store.upsertStockMovement(docId, doc);
      result.pushedMovements += 1;
    }
    config.set(FINHUB_KEYS.lastStockPushAt, queryStart);
  }
}
