/**
 * Opening-catalogue import (FM-01..FM-04 in bulk).
 *
 * Loads the HQ catalogue carried over from the previous POS. Everything goes
 * through ProductService, so each product is created exactly as if a manager had
 * typed it: audit log, outbox row and price history all behave normally and the
 * rows sync like any other.
 *
 * The plan is worked out before anything is written, so the screen can show what
 * will happen and the manager can decline. Safe to run twice: a product already
 * here is matched on its barcode, then on its name, and is left alone apart from
 * barcodes it is missing.
 *
 * Stock is deliberately NOT imported. The old system's quantities were mostly
 * negative — opening stock belongs to a stock count, not to a catalogue.
 */
import type { DB } from '../db/connection';
import type { ProductService } from './product-service';
import { HQ_CATALOGUE, type CatalogueItem } from '../catalogue/hq-catalogue';

export type CatalogueAction = 'create' | 'add-barcodes' | 'unchanged';

export interface CatalogueConflict {
  barcode: string;
  /** Name of the product that already holds this barcode. */
  heldBy: string;
}

export interface CataloguePlanRow {
  /** The catalogue line itself. Carried here rather than looked up again by name:
   *  the export holds names that differ only by case ("Mansa sugar 1kg" and
   *  "Mansa Sugar 1kg" are two different products), so a name is not a key. */
  item: CatalogueItem;
  name: string;
  category: string;
  action: CatalogueAction;
  matchedBy: 'barcode' | 'name' | null;
  existingId: string | null;
  barcodesToAdd: string[];
  conflicts: CatalogueConflict[];
}

export interface CataloguePlan {
  rows: CataloguePlanRow[];
  toCreate: number;
  toAddBarcodes: number;
  unchanged: number;
  /** Products that will exist with no barcode until one is scanned onto them. */
  withoutBarcode: string[];
  /** Barcodes the catalogue wants but another product already holds. */
  conflicts: CatalogueConflict[];
}

export interface CatalogueImportResult {
  created: number;
  barcodesAdded: number;
  unchanged: number;
  failed: { name: string; reason: string }[];
}

interface IndexRow {
  id: string;
  name: string;
  barcode: string | null;
}

const normalise = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

export class CatalogueService {
  constructor(
    private readonly db: DB,
    private readonly products: ProductService,
  ) {}

  /** One pass over products + barcodes, rather than a query per catalogue line. */
  private index(): { byBarcode: Map<string, IndexRow>; byName: Map<string, IndexRow | null> } {
    const rows = this.db
      .prepare(
        `SELECT p.id AS id, p.name AS name, b.barcode AS barcode
           FROM products p LEFT JOIN barcodes b ON b.product_id = p.id`,
      )
      .all() as IndexRow[];

    const byBarcode = new Map<string, IndexRow>();
    const byName = new Map<string, IndexRow | null>();
    for (const row of rows) {
      if (row.barcode) byBarcode.set(row.barcode, row);
      const key = normalise(row.name);
      // A name held by two products identifies neither, so it matches nothing.
      byName.set(key, byName.has(key) && byName.get(key)?.id !== row.id ? null : row);
    }
    return { byBarcode, byName };
  }

  private existingBarcodes(productId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT barcode FROM barcodes WHERE product_id = ?')
      .all(productId) as { barcode: string }[];
    return new Set(rows.map((r) => r.barcode));
  }

  plan(catalogue: CatalogueItem[] = HQ_CATALOGUE): CataloguePlan {
    const { byBarcode, byName } = this.index();
    const claimed = new Set<string>();
    const rows: CataloguePlanRow[] = [];

    for (const item of catalogue) {
      const match =
        item.barcodes.map((b) => byBarcode.get(b)).find(Boolean) ??
        byName.get(normalise(item.name)) ??
        null;

      if (!match) {
        // A barcode another product holds, or that an earlier line in this same
        // run has already taken, cannot go on this one: the barcodes table is
        // UNIQUE and the insert would throw away the whole product. Import it
        // without that code and say so.
        const free: string[] = [];
        const clash: CatalogueConflict[] = [];
        for (const barcode of item.barcodes) {
          const owner = byBarcode.get(barcode);
          if (owner || claimed.has(barcode)) {
            clash.push({ barcode, heldBy: owner?.name ?? 'another line in this catalogue' });
            continue;
          }
          free.push(barcode);
          claimed.add(barcode);
        }
        rows.push({
          item,
          name: item.name,
          category: item.category,
          action: 'create',
          matchedBy: null,
          existingId: null,
          barcodesToAdd: free,
          conflicts: clash,
        });
        continue;
      }

      const matchedBy = item.barcodes.some((b) => byBarcode.has(b)) ? 'barcode' : 'name';
      const held = this.existingBarcodes(match.id);
      const toAdd: string[] = [];
      const conflicts: CatalogueConflict[] = [];

      for (const barcode of item.barcodes) {
        if (held.has(barcode)) continue;
        const owner = byBarcode.get(barcode);
        if ((owner && owner.id !== match.id) || claimed.has(barcode)) {
          conflicts.push({ barcode, heldBy: owner?.name ?? item.name });
          continue;
        }
        toAdd.push(barcode);
        claimed.add(barcode);
      }

      rows.push({
        item,
        name: item.name,
        category: item.category,
        action: toAdd.length > 0 ? 'add-barcodes' : 'unchanged',
        matchedBy,
        existingId: match.id,
        barcodesToAdd: toAdd,
        conflicts,
      });
    }

    return {
      rows,
      toCreate: rows.filter((r) => r.action === 'create').length,
      toAddBarcodes: rows.filter((r) => r.action === 'add-barcodes').length,
      unchanged: rows.filter((r) => r.action === 'unchanged').length,
      withoutBarcode: catalogue.filter((i) => i.barcodes.length === 0).map((i) => i.name),
      conflicts: rows.flatMap((r) => r.conflicts),
    };
  }

  /**
   * Applies the plan. Each product is written in its own transaction (that is what
   * ProductService.create does), so a failure part-way leaves the products already
   * imported intact and re-running picks up the rest rather than starting over.
   */
  import(actorId: string, catalogue: CatalogueItem[] = HQ_CATALOGUE): CatalogueImportResult {
    const plan = this.plan(catalogue);
    const result: CatalogueImportResult = {
      created: 0,
      barcodesAdded: 0,
      unchanged: plan.unchanged,
      failed: [],
    };

    for (const row of plan.rows) {
      const item = row.item;
      try {
        if (row.action === 'create') {
          this.products.create(
            {
              name: item.name,
              category: item.category,
              unitPrice: item.unitPrice,
              unitOfMeasure: item.unitOfMeasure,
              isWeightBased: item.isWeightBased,
              barcodes: row.barcodesToAdd.map((barcode) => ({ barcode })),
            },
            actorId,
          );
          result.created += 1;
        } else if (row.action === 'add-barcodes' && row.existingId) {
          for (const barcode of row.barcodesToAdd) {
            this.products.addBarcode(row.existingId, { barcode }, actorId);
            result.barcodesAdded += 1;
          }
        }
      } catch (err) {
        result.failed.push({
          name: row.name,
          reason: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return result;
  }
}
