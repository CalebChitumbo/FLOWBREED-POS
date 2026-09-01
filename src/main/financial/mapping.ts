/**
 * Pure POS ⇄ Financial-app mapping (no I/O, no Electron, fully unit-tested).
 *
 * The two systems disagree on three conventions, and every translation between
 * them lives here so it can never drift screen-by-screen:
 *   * money    — POS: INTEGER ngwee; Financial: ZMW major-unit numbers
 *   * time     — POS: ISO-8601 UTC instants; Financial: 'YYYY-MM-DD' business
 *                days in Africa/Lusaka (UTC+2, no DST)
 *   * products — POS UUIDs vs the Financial catalogue's own ids; sale lines and
 *                movements carry the Financial id when a product is linked, and
 *                fall back to the POS id (the Financial app deliberately keeps
 *                counting "unknown" product ids rather than dropping them)
 */
import type {
  FinancialSaleLine,
  FinancialShopSaleDoc,
  FinancialStockMovementDoc,
} from './types';

/** Africa/Lusaka is UTC+2 all year (Zambia has no DST). */
export const LUSAKA_UTC_OFFSET_MINUTES = 120;

/** Marker prefix on stock_movements.reference_id for rows the bridge itself
 *  applied from HQ deliveries — such rows are never echoed back up. */
export const FINHUB_REF_PREFIX = 'finhub:';

/** The business day (Financial-app date string) an ISO UTC instant falls on. */
export function businessDate(isoUtc: string, offsetMinutes = LUSAKA_UTC_OFFSET_MINUTES): string {
  return new Date(Date.parse(isoUtc) + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** SQLite date() modifier matching businessDate(), e.g. '+120 minutes'. */
export function sqlBusinessDayModifier(offsetMinutes = LUSAKA_UTC_OFFSET_MINUTES): string {
  return `${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`;
}

/** INTEGER ngwee -> ZMW major units, exact to 2dp. */
export function ngweeToKwacha(ngwee: number): number {
  return Math.round(ngwee) / 100;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Deterministic shopSales doc id for one POS terminal's business day. HQ manual
 * entry uses `date__shopId`; including the terminal keeps a till and a possible
 * HQ correction (or a second till) from overwriting each other, while re-pushes
 * from the same till always land on the same doc.
 */
export function saleDocId(date: string, shopId: string, terminalId: string): string {
  return `${date}__${shopId}__pos__${terminalId}`;
}

/** Per-(product, unit price, txn type) sums for one business day, from SQL. */
export interface DayLineAgg {
  productId: string; // POS product id
  productName: string;
  unit: string;
  unitPriceNgwee: number; // price actually charged (unit_price_at_sale)
  txnType: 'sale' | 'refund';
  quantity: number; // positive
  grossNgwee: number; // Σ(line_total + line_discount), positive
}

export interface BuildShopSaleInput {
  date: string;
  shopId: string;
  terminalId: string;
  branchName: string;
  rows: DayLineAgg[];
  /** Σ transactions.discount_total over the day's completed sales (includes line discounts). */
  saleDiscountNgwee: number;
  saleCount: number;
  refundCount: number;
  /** POS product id -> Financial catalogue id (only linked products present). */
  financialIdByProduct: Map<string, string>;
  nowIso: string;
}

/**
 * Aggregate one business day of till activity into the Financial app's ShopSale
 * shape. Sales add, refunds subtract at the price they were rung up at, so the
 * same product at two prices stays two lines (the Financial app explicitly
 * allows that). Discounts are posted as negative `otherSales` rather than being
 * smeared into unit prices, keeping every line's quantity × price exact AND
 * `total` equal to the net money actually taken:
 *   total = Σ sale grand totals − Σ refund grand totals.
 */
export function buildShopSaleDoc(input: BuildShopSaleInput): FinancialShopSaleDoc {
  interface Merged {
    productId: string;
    productName: string;
    unit: string;
    unitPriceNgwee: number;
    quantity: number;
    grossNgwee: number;
  }
  const merged = new Map<string, Merged>();

  for (const row of input.rows) {
    const financialId = input.financialIdByProduct.get(row.productId);
    const productId = financialId ?? row.productId;
    const sign = row.txnType === 'refund' ? -1 : 1;
    const key = `${productId}__${row.unitPriceNgwee}`;
    const entry = merged.get(key) ?? {
      productId,
      productName: row.productName,
      unit: row.unit,
      unitPriceNgwee: row.unitPriceNgwee,
      quantity: 0,
      grossNgwee: 0,
    };
    entry.quantity += sign * row.quantity;
    entry.grossNgwee += sign * row.grossNgwee;
    merged.set(key, entry);
  }

  const lines: FinancialSaleLine[] = [...merged.values()]
    .filter((m) => m.quantity !== 0 || m.grossNgwee !== 0)
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.unitPriceNgwee - b.unitPriceNgwee)
    .map((m) => ({
      productId: m.productId,
      productName: m.productName,
      unit: m.unit,
      quantity: round2(m.quantity),
      priceType: 'retail' as const,
      unitPrice: ngweeToKwacha(m.unitPriceNgwee),
      amount: ngweeToKwacha(m.grossNgwee),
    }));

  const otherSales = input.saleDiscountNgwee ? -ngweeToKwacha(input.saleDiscountNgwee) : 0;
  const total = round2(lines.reduce((s, l) => s + l.amount, 0) + otherSales);

  let notes =
    `Automatic push from Flowbreeds POS — branch "${input.branchName}", terminal ${input.terminalId}. ` +
    `${input.saleCount} sale(s), ${input.refundCount} refund(s).`;
  if (input.saleDiscountNgwee > 0) {
    notes += ` Discounts of K${ngweeToKwacha(input.saleDiscountNgwee).toFixed(2)} are included as negative Other sales.`;
  }

  return {
    date: input.date,
    shopId: input.shopId,
    lines,
    otherSales,
    total,
    source: 'POS',
    terminalId: input.terminalId,
    notes,
    createdAt: input.nowIso, // the store keeps the original on re-push
    updatedAt: input.nowIso,
    updatedBy: `pos:${input.terminalId}`,
  };
}

// ---------------------------------------------------------------------------
// HQ deliveries (Financial stockMovements) -> local inventory operations
// ---------------------------------------------------------------------------

export interface StockOp {
  posProductId: string;
  /** Signed: positive = into this branch, negative = out of it. */
  quantity: number;
}

export interface SkippedLine {
  productName: string;
  quantity: number;
  reason: string;
}

export interface MovementApplication {
  /** False when the movement doesn't touch this shop at all. */
  relevant: boolean;
  ops: StockOp[];
  skipped: SkippedLine[];
  /** Human-readable description for movement notes / the applied ledger. */
  description: string;
}

/** Plain-English label for a Financial movement, seen from this shop. */
function describeMovement(
  doc: Pick<FinancialStockMovementDoc, 'kind' | 'fromShopId' | 'toShopId' | 'destination' | 'source'>,
  myShopId: string,
): string {
  const inbound = doc.toShopId === myShopId;
  if (doc.kind === 'SUPPLY') return `Supply from ${doc.source}`;
  if (doc.kind === 'TRANSFER') {
    return inbound
      ? `Transfer in from ${doc.fromShopId ?? 'unknown shop'}`
      : `Transfer out to ${doc.toShopId ?? 'unknown shop'}`;
  }
  return `Ad-hoc dispatch to ${doc.destination || 'unspecified destination'}`;
}

/**
 * Work out what a Financial stock movement means for THIS branch's inventory.
 * Signs follow §6.2 of the Financial spec: anything TO the shop counts in,
 * anything FROM the shop counts out; a movement touching neither is ignored.
 * Lines whose product has no local link are surfaced as skipped, never lost.
 */
export function movementToStockOps(
  doc: FinancialStockMovementDoc,
  myShopId: string,
  posIdByFinancialId: Map<string, string>,
): MovementApplication {
  const factor = (doc.toShopId === myShopId ? 1 : 0) + (doc.fromShopId === myShopId ? -1 : 0);
  if (factor === 0) return { relevant: false, ops: [], skipped: [], description: '' };

  const ops: StockOp[] = [];
  const skipped: SkippedLine[] = [];
  for (const line of doc.lines ?? []) {
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const posProductId = posIdByFinancialId.get(line.productId);
    if (!posProductId) {
      skipped.push({
        productName: line.productName || line.productId,
        quantity: qty,
        reason: 'no matching POS product (link it in Products or enable catalogue pull)',
      });
      continue;
    }
    ops.push({ posProductId, quantity: factor * qty });
  }
  return { relevant: true, ops, skipped, description: describeMovement(doc, myShopId) };
}

// ---------------------------------------------------------------------------
// Local stock_in / adjustments -> Financial stockMovements (push up)
// ---------------------------------------------------------------------------

export interface PosMovementForPush {
  id: string;
  type: 'stock_in' | 'adjustment';
  quantity: number; // signed as stored
  datetime: string; // ISO UTC
  reason: string | null;
  notes: string | null;
  productId: string;
  productName: string;
  unit: string;
  financialId: string | null;
}

/**
 * Map a locally recorded stock receipt/adjustment to the Financial app's
 * movement shape, so the books' derived stock keeps step with the shelf:
 *   stock_in            -> SUPPLY (Purchase) into the shop
 *   adjustment (gain)   -> SUPPLY (Other) into the shop
 *   adjustment (loss)   -> ADHOC out of the shop
 * The doc id is derived from the POS movement id, so re-pushes overwrite.
 */
export function posMovementToFinancialDoc(
  m: PosMovementForPush,
  shopId: string,
  terminalId: string,
  nowIso: string,
): { docId: string; doc: FinancialStockMovementDoc } {
  const outbound = m.type === 'adjustment' && m.quantity < 0;
  const noteBits = [
    m.type === 'stock_in' ? 'POS stock-in' : `POS stock adjustment${m.reason ? `: ${m.reason}` : ''}`,
    m.notes ?? '',
    `(terminal ${terminalId})`,
  ].filter(Boolean);

  const doc: FinancialStockMovementDoc = {
    date: businessDate(m.datetime),
    kind: outbound ? 'ADHOC' : 'SUPPLY',
    fromShopId: outbound ? shopId : null,
    toShopId: outbound ? null : shopId,
    destination: outbound ? 'POS stock adjustment' : '',
    source: m.type === 'stock_in' ? 'Purchase' : 'Other',
    lines: [
      {
        productId: m.financialId ?? m.productId,
        productName: m.productName,
        unit: m.unit,
        quantity: Math.abs(m.quantity),
      },
    ],
    note: noteBits.join(' '),
    updatedAt: nowIso,
    updatedBy: `pos:${terminalId}`,
  };
  return { docId: `pos-${m.id}`, doc };
}
