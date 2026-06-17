/**
 * Sales engine (FS, NR). A sale writes the transaction, its line items, the stock
 * movements and the inventory decrement in ONE SQLite transaction (transactional
 * outbox enqueued in the same txn). The receipt is composed AFTER the commit, so a
 * printer fault can never lose a sale (FS-08, save-before-print). Refunds reference
 * the original transaction and return stock.
 */
import type { DB } from '../db/connection';
import type { PaymentMethod } from '@shared/constants';
import { CONFIG_KEYS } from '@shared/constants';
import type { Transaction, TransactionItem } from '@shared/types/domain';
import type { ReceiptData, ReceiptLine } from '@shared/types/receipt';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { Errors } from '../errors';
import { composeReceipt } from './receipt';
import type { AuditService } from './audit-service';
import type { OutboxService } from './outbox-service';
import type { ProductService } from './product-service';
import type { BranchService } from './branch-service';
import type { InventoryService } from './inventory-service';
import type { TillSessionService } from './till-session-service';
import type { ConfigService } from './config-service';

export interface SaleItemInput {
  productId: string;
  quantity: number;
  lineDiscount?: number; // minor units
}

export interface CreateSaleInput {
  items: SaleItemInput[];
  paymentMethod: PaymentMethod;
  tendered?: number; // minor units (cash only)
  transactionDiscount?: number; // minor units, manager-authorised
  authorisedBy?: string; // manager userId if any discount applied
}

export interface CreateRefundInput {
  originalTxnId: string;
  items: { productId: string; quantity: number }[];
}

export interface Cashier {
  userId: string;
  username: string;
}

export interface SaleResult {
  transaction: Transaction;
  receipt: ReceiptData;
}

interface TxnRow {
  id: string;
  reference: string;
  branch_id: string;
  cashier_id: string;
  session_id: string;
  datetime: string;
  type: 'sale' | 'refund';
  original_txn_id: string | null;
  payment_method: PaymentMethod;
  subtotal: number;
  discount_total: number;
  grand_total: number;
  tendered: number | null;
  change_due: number | null;
  status: 'completed' | 'voided' | 'held';
  authorised_by: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
}

interface ItemRow {
  id: string;
  transaction_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_at_sale: number;
  line_discount: number;
  line_total: number;
  is_weight_based: number;
}

function toItem(row: ItemRow): TransactionItem {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    unitPriceAtSale: row.unit_price_at_sale,
    lineDiscount: row.line_discount,
    lineTotal: row.line_total,
    isWeightBased: row.is_weight_based === 1,
  };
}

function toTransaction(row: TxnRow, items: TransactionItem[]): Transaction {
  return {
    id: row.id,
    reference: row.reference,
    branchId: row.branch_id,
    cashierId: row.cashier_id,
    sessionId: row.session_id,
    datetime: row.datetime,
    type: row.type,
    originalTxnId: row.original_txn_id,
    paymentMethod: row.payment_method,
    subtotal: row.subtotal,
    discountTotal: row.discount_total,
    grandTotal: row.grand_total,
    tendered: row.tendered,
    changeDue: row.change_due,
    status: row.status,
    authorisedBy: row.authorised_by,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: row.sync_status as Transaction['syncStatus'],
  };
}

export class SaleService {
  constructor(
    private readonly db: DB,
    private readonly products: ProductService,
    private readonly branches: BranchService,
    private readonly inventory: InventoryService,
    private readonly tills: TillSessionService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  get(id: string): Transaction | undefined {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TxnRow | undefined;
    if (!row) return undefined;
    const items = (
      this.db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(id) as ItemRow[]
    ).map(toItem);
    return toTransaction(row, items);
  }

  private nextReference(branchId: string): string {
    const seq =
      (this.db.prepare('SELECT count(*) AS c FROM transactions WHERE branch_id = ?').get(branchId) as {
        c: number;
      }).c + 1;
    return `${branchId.slice(0, 4).toUpperCase()}-${String(seq).padStart(6, '0')}`;
  }

  private receiptHeader(): { businessName: string; address: string | null; contact: string | null } {
    const header = this.config.getJson<{ businessName?: string; address?: string; contact?: string }>(
      CONFIG_KEYS.receiptHeader,
    );
    return {
      businessName: header?.businessName ?? 'Flowbreeds Farms Shop',
      address: header?.address ?? null,
      contact: header?.contact ?? null,
    };
  }

  private buildReceipt(txn: Transaction, cashierName: string): ReceiptData {
    const header = this.receiptHeader();
    const lines: ReceiptLine[] = (txn.items ?? []).map((it) => ({
      name: it.productName,
      quantity: it.quantity,
      unitPrice: it.unitPriceAtSale,
      lineTotal: it.lineTotal,
      isWeightBased: it.isWeightBased,
    }));
    return composeReceipt({
      ...header,
      branchName: this.branches.getCurrent().name,
      reference: txn.reference,
      datetime: txn.datetime,
      cashier: cashierName,
      type: txn.type,
      lines,
      subtotal: txn.subtotal,
      discountTotal: txn.discountTotal,
      grandTotal: txn.grandTotal,
      paymentMethod: txn.paymentMethod,
      tendered: txn.tendered,
      changeDue: txn.changeDue,
    });
  }

  /** Re-compose a receipt for an existing transaction (reprint). */
  receiptFor(transactionId: string, cashierName: string): ReceiptData {
    const txn = this.get(transactionId);
    if (!txn) throw Errors.notFound('transaction');
    return this.buildReceipt(txn, cashierName);
  }

  create(input: CreateSaleInput, cashier: Cashier): SaleResult {
    if (!input.items.length) throw Errors.validation('Add at least one item to the sale.');
    const branchId = this.branches.getCurrentId();
    const session = this.tills.getOpenForCashier(cashier.userId);
    if (!session) throw Errors.conflict('Open a till session before making a sale.');

    const lines = input.items.map((it) => {
      if (it.quantity <= 0) throw Errors.validation('Quantity must be greater than zero.');
      const product = this.products.get(it.productId);
      if (!product) throw Errors.notFound('product');
      if (!product.active) throw Errors.validation(`"${product.name}" is no longer available.`);
      const gross = Math.round(it.quantity * product.unitPrice);
      const lineDiscount = it.lineDiscount ?? 0;
      return {
        product,
        quantity: it.quantity,
        unitPrice: product.unitPrice,
        gross,
        lineDiscount,
        lineTotal: gross - lineDiscount,
      };
    });

    const subtotal = lines.reduce((s, l) => s + l.gross, 0);
    const lineDiscounts = lines.reduce((s, l) => s + l.lineDiscount, 0);
    const txnDiscount = input.transactionDiscount ?? 0;
    const discountTotal = lineDiscounts + txnDiscount;
    const grandTotal = subtotal - discountTotal;

    if (discountTotal < 0) throw Errors.validation('Discount cannot be negative.');
    if (grandTotal < 0) throw Errors.validation('The discount is larger than the total.');
    if (discountTotal > 0 && !input.authorisedBy) {
      throw Errors.forbidden();
    }
    if (input.paymentMethod === 'cash') {
      if (input.tendered == null || input.tendered < grandTotal) {
        throw Errors.validation('Cash tendered is less than the total due.');
      }
    }

    const tendered = input.paymentMethod === 'cash' ? input.tendered! : null;
    const changeDue = input.paymentMethod === 'cash' ? (input.tendered as number) - grandTotal : null;

    const id = newId();
    const now = nowIso();
    const reference = this.nextReference(branchId);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO transactions
             (id, reference, branch_id, cashier_id, session_id, datetime, type, original_txn_id,
              payment_method, subtotal, discount_total, grand_total, tendered, change_due, status,
              authorised_by, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, 'sale', NULL, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, 'pending')`,
        )
        .run(
          id,
          reference,
          branchId,
          cashier.userId,
          session.id,
          now,
          input.paymentMethod,
          subtotal,
          discountTotal,
          grandTotal,
          tendered,
          changeDue,
          input.authorisedBy ?? null,
          now,
          now,
        );
      this.outbox.enqueue('transaction', id, 'create', { id, reference, grandTotal, type: 'sale' });

      for (const line of lines) {
        const itemId = newId();
        this.db
          .prepare(
            `INSERT INTO transaction_items
               (id, transaction_id, product_id, product_name, quantity, unit_price_at_sale,
                line_discount, line_total, is_weight_based, sync_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(
            itemId,
            id,
            line.product.id,
            line.product.name,
            line.quantity,
            line.unitPrice,
            line.lineDiscount,
            line.lineTotal,
            line.product.isWeightBased ? 1 : 0,
          );
        this.outbox.enqueue('transaction_item', itemId, 'create', { id: itemId, transactionId: id });

        // Decrement stock (FI-02) in the same transaction.
        this.inventory.recordMovement({
          productId: line.product.id,
          branchId,
          type: 'sale',
          quantity: -line.quantity,
          referenceId: id,
          userId: cashier.userId,
        });
      }

      this.audit.record({
        userId: cashier.userId,
        action: 'sale',
        entityType: 'transaction',
        entityId: id,
        newValue: { reference, grandTotal, paymentMethod: input.paymentMethod },
      });
      if (discountTotal > 0) {
        this.audit.record({
          userId: cashier.userId,
          action: 'discount',
          entityType: 'transaction',
          entityId: id,
          newValue: { discountTotal, authorisedBy: input.authorisedBy },
        });
      }
    })();

    const transaction = this.get(id)!;
    return { transaction, receipt: this.buildReceipt(transaction, cashier.username) };
  }

  refund(input: CreateRefundInput, cashier: Cashier): SaleResult {
    if (!input.items.length) throw Errors.validation('Select at least one item to refund.');
    const branchId = this.branches.getCurrentId();
    const session = this.tills.getOpenForCashier(cashier.userId);
    if (!session) throw Errors.conflict('Open a till session before processing a refund.');

    const original = this.get(input.originalTxnId);
    if (!original) throw Errors.notFound('original transaction');
    if (original.type !== 'sale') throw Errors.validation('Refunds must reference an original sale.');

    const originalItems = new Map((original.items ?? []).map((it) => [it.productId, it]));
    const lines = input.items.map((ri) => {
      const orig = originalItems.get(ri.productId);
      if (!orig) throw Errors.validation('That item was not part of the original sale.');
      if (ri.quantity <= 0 || ri.quantity > orig.quantity) {
        throw Errors.validation('Refund quantity exceeds the quantity sold.');
      }
      const lineTotal = Math.round(ri.quantity * orig.unitPriceAtSale);
      return { orig, quantity: ri.quantity, unitPrice: orig.unitPriceAtSale, lineTotal };
    });

    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const grandTotal = subtotal;
    const id = newId();
    const now = nowIso();
    const reference = this.nextReference(branchId);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO transactions
             (id, reference, branch_id, cashier_id, session_id, datetime, type, original_txn_id,
              payment_method, subtotal, discount_total, grand_total, tendered, change_due, status,
              authorised_by, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, 'refund', ?, ?, ?, 0, ?, NULL, NULL, 'completed', ?, ?, ?, 'pending')`,
        )
        .run(
          id,
          reference,
          branchId,
          cashier.userId,
          session.id,
          now,
          original.id,
          original.paymentMethod,
          subtotal,
          grandTotal,
          cashier.userId,
          now,
          now,
        );
      this.outbox.enqueue('transaction', id, 'create', { id, reference, grandTotal, type: 'refund' });

      for (const line of lines) {
        const itemId = newId();
        this.db
          .prepare(
            `INSERT INTO transaction_items
               (id, transaction_id, product_id, product_name, quantity, unit_price_at_sale,
                line_discount, line_total, is_weight_based, sync_status)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending')`,
          )
          .run(
            itemId,
            id,
            line.orig.productId,
            line.orig.productName,
            line.quantity,
            line.unitPrice,
            line.lineTotal,
            line.orig.isWeightBased ? 1 : 0,
          );
        this.outbox.enqueue('transaction_item', itemId, 'create', { id: itemId, transactionId: id });

        // Return stock (FI-02).
        this.inventory.recordMovement({
          productId: line.orig.productId,
          branchId,
          type: 'return',
          quantity: line.quantity,
          referenceId: id,
          userId: cashier.userId,
        });
      }

      this.audit.record({
        userId: cashier.userId,
        action: 'refund',
        entityType: 'transaction',
        entityId: id,
        oldValue: { originalTxnId: original.id },
        newValue: { reference, grandTotal },
      });
    })();

    const transaction = this.get(id)!;
    return { transaction, receipt: this.buildReceipt(transaction, cashier.username) };
  }
}
