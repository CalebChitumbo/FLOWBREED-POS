/**
 * Product catalogue (FM-01..FM-07): unique multi-barcodes, weight-based items,
 * categories, soft deactivation (never hard delete), and price-change logging.
 */
import type { DB } from '../db/connection';
import type { Product, Barcode, PriceHistoryEntry } from '@shared/types/domain';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { Errors } from '../errors';
import type { AuditService } from './audit-service';
import type { OutboxService } from './outbox-service';

interface ProductRow {
  id: string;
  name: string;
  category: string;
  unit_price: number;
  unit_of_measure: string;
  is_weight_based: number;
  low_stock_threshold: number;
  active: number;
  financial_id: string | null;
  created_at: string;
  updated_at: string;
}

interface BarcodeRow {
  id: string;
  product_id: string;
  barcode: string;
  pack_label: string | null;
  created_at: string;
}

export interface BarcodeInput {
  barcode: string;
  packLabel?: string | null;
}

export interface CreateProductInput {
  name: string;
  category: string;
  unitPrice: number; // minor units
  unitOfMeasure: string;
  isWeightBased?: boolean;
  lowStockThreshold?: number;
  barcodes?: BarcodeInput[];
}

export interface UpdateProductInput {
  name?: string;
  category?: string;
  unitPrice?: number;
  unitOfMeasure?: string;
  isWeightBased?: boolean;
  lowStockThreshold?: number;
  active?: boolean;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unitPrice: row.unit_price,
    unitOfMeasure: row.unit_of_measure,
    isWeightBased: row.is_weight_based === 1,
    lowStockThreshold: row.low_stock_threshold,
    active: row.active === 1,
    financialId: row.financial_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarcode(row: BarcodeRow): Barcode {
  return {
    id: row.id,
    productId: row.product_id,
    barcode: row.barcode,
    packLabel: row.pack_label,
    createdAt: row.created_at,
  };
}

export class ProductService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  getBarcodes(productId: string): Barcode[] {
    const rows = this.db
      .prepare('SELECT * FROM barcodes WHERE product_id = ? ORDER BY created_at')
      .all(productId) as BarcodeRow[];
    return rows.map(toBarcode);
  }

  private rowById(id: string): ProductRow | undefined {
    return this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
  }

  get(id: string): Product | undefined {
    const row = this.rowById(id);
    if (!row) return undefined;
    const product = toProduct(row);
    product.barcodes = this.getBarcodes(id);
    return product;
  }

  list(includeInactive = false): Product[] {
    const sql = includeInactive
      ? 'SELECT * FROM products ORDER BY name'
      : 'SELECT * FROM products WHERE active = 1 ORDER BY name';
    return (this.db.prepare(sql).all() as ProductRow[]).map(toProduct);
  }

  /** Checkout hot path: barcode -> product via the UNIQUE index (NP-01). */
  findByBarcode(barcode: string): Product | null {
    const row = this.db
      .prepare(
        `SELECT p.* FROM products p JOIN barcodes b ON b.product_id = p.id WHERE b.barcode = ?`,
      )
      .get(barcode.trim()) as ProductRow | undefined;
    return row ? toProduct(row) : null;
  }

  /** Manual search by name or barcode prefix (FM-02, FS-02); active products only. */
  search(query: string): Product[] {
    const q = `%${query.trim()}%`;
    const bq = `${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM products p
         LEFT JOIN barcodes b ON b.product_id = p.id
         WHERE p.active = 1 AND (p.name LIKE @q OR b.barcode LIKE @bq)
         ORDER BY p.name LIMIT 50`,
      )
      .all({ q, bq }) as ProductRow[];
    return rows.map(toProduct);
  }

  private assertBarcodeFree(barcode: string): void {
    const existing = this.db.prepare('SELECT id FROM barcodes WHERE barcode = ?').get(barcode);
    if (existing) throw Errors.conflict(`Barcode "${barcode}" is already assigned to another product.`);
  }

  create(input: CreateProductInput, actorId: string): Product {
    const name = input.name.trim();
    if (!name) throw Errors.validation('A product name is required.');
    if (input.unitPrice < 0) throw Errors.validation('Price cannot be negative.');

    const barcodes = input.barcodes ?? [];
    for (const b of barcodes) this.assertBarcodeFree(b.barcode.trim());

    const id = newId();
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO products
             (id, name, category, unit_price, unit_of_measure, is_weight_based, low_stock_threshold, active, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending')`,
        )
        .run(
          id,
          name,
          input.category,
          input.unitPrice,
          input.unitOfMeasure,
          input.isWeightBased ? 1 : 0,
          input.lowStockThreshold ?? 0,
          now,
          now,
        );
      this.outbox.enqueue('product', id, 'create', { id, name, category: input.category });

      for (const b of barcodes) this.insertBarcode(id, b, now);

      this.audit.record({
        userId: actorId,
        action: 'product_create',
        entityType: 'product',
        entityId: id,
        newValue: { name, category: input.category, unitPrice: input.unitPrice },
      });
    })();

    return this.get(id)!;
  }

  private insertBarcode(productId: string, input: BarcodeInput, now: string): Barcode {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO barcodes (id, product_id, barcode, pack_label, created_at, sync_status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      .run(id, productId, input.barcode.trim(), input.packLabel ?? null, now);
    this.outbox.enqueue('barcode', id, 'create', {
      id,
      productId,
      barcode: input.barcode.trim(),
      packLabel: input.packLabel ?? null,
    });
    return toBarcode({
      id,
      product_id: productId,
      barcode: input.barcode.trim(),
      pack_label: input.packLabel ?? null,
      created_at: now,
    });
  }

  addBarcode(productId: string, input: BarcodeInput, actorId: string): Barcode {
    if (!this.rowById(productId)) throw Errors.notFound('product');
    this.assertBarcodeFree(input.barcode.trim());
    const now = nowIso();
    let created!: Barcode;
    this.db.transaction(() => {
      created = this.insertBarcode(productId, input, now);
      this.audit.record({
        userId: actorId,
        action: 'barcode_add',
        entityType: 'product',
        entityId: productId,
        newValue: { barcode: input.barcode.trim() },
      });
    })();
    return created;
  }

  removeBarcode(barcodeId: string, actorId: string): void {
    const row = this.db.prepare('SELECT * FROM barcodes WHERE id = ?').get(barcodeId) as
      | BarcodeRow
      | undefined;
    if (!row) throw Errors.notFound('barcode');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM barcodes WHERE id = ?').run(barcodeId);
      this.outbox.enqueue('barcode', barcodeId, 'delete', { id: barcodeId });
      this.audit.record({
        userId: actorId,
        action: 'barcode_remove',
        entityType: 'product',
        entityId: row.product_id,
        oldValue: { barcode: row.barcode },
      });
    })();
  }

  /** Updates fields; if unitPrice changes, records a price_history entry (FM-07). */
  update(id: string, patch: UpdateProductInput, actorId: string): Product {
    const existing = this.rowById(id);
    if (!existing) throw Errors.notFound('product');

    const next = {
      name: patch.name?.trim() ?? existing.name,
      category: patch.category ?? existing.category,
      unitPrice: patch.unitPrice ?? existing.unit_price,
      unitOfMeasure: patch.unitOfMeasure ?? existing.unit_of_measure,
      isWeightBased: patch.isWeightBased === undefined ? existing.is_weight_based : patch.isWeightBased ? 1 : 0,
      lowStockThreshold: patch.lowStockThreshold ?? existing.low_stock_threshold,
      active: patch.active === undefined ? existing.active : patch.active ? 1 : 0,
    };
    if (next.unitPrice < 0) throw Errors.validation('Price cannot be negative.');
    const now = nowIso();
    const priceChanged = next.unitPrice !== existing.unit_price;

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE products SET name = ?, category = ?, unit_price = ?, unit_of_measure = ?,
             is_weight_based = ?, low_stock_threshold = ?, active = ?, updated_at = ?, sync_status = 'pending'
           WHERE id = ?`,
        )
        .run(
          next.name,
          next.category,
          next.unitPrice,
          next.unitOfMeasure,
          next.isWeightBased,
          next.lowStockThreshold,
          next.active,
          now,
          id,
        );
      this.outbox.enqueue('product', id, 'update', { id, name: next.name, unitPrice: next.unitPrice });

      if (priceChanged) {
        const phId = newId();
        this.db
          .prepare(
            `INSERT INTO price_history (id, product_id, old_price, new_price, changed_by, datetime)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(phId, id, existing.unit_price, next.unitPrice, actorId, now);
        this.outbox.enqueue('price_history', phId, 'create', {
          id: phId,
          productId: id,
          oldPrice: existing.unit_price,
          newPrice: next.unitPrice,
          changedBy: actorId,
          datetime: now,
        });
        this.audit.record({
          userId: actorId,
          action: 'price_change',
          entityType: 'product',
          entityId: id,
          oldValue: { unitPrice: existing.unit_price },
          newValue: { unitPrice: next.unitPrice },
        });
      }

      this.audit.record({
        userId: actorId,
        action: 'product_update',
        entityType: 'product',
        entityId: id,
        newValue: { name: next.name, active: next.active },
      });
    })();

    return this.get(id)!;
  }

  priceHistory(productId: string): PriceHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM price_history WHERE product_id = ? ORDER BY datetime DESC')
      .all(productId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      productId: r.product_id as string,
      oldPrice: r.old_price as number,
      newPrice: r.new_price as number,
      changedBy: r.changed_by as string,
      datetime: r.datetime as string,
    }));
  }
}
