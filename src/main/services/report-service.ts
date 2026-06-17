/**
 * Reporting (FR). Read-only aggregate queries over transactions, items and stock
 * movements. Indexes on transactions(datetime, branch_id) and
 * transaction_items(product_id) keep date-range reports within the perf target
 * (NP-04). Refunds count negatively against revenue.
 */
import type { DB } from '../db/connection';
import type { Transaction } from '@shared/types/domain';
import type { SalesReport, StockMovementView, TransactionFilter } from '@shared/types/report';
import type { StockMovementType } from '@shared/constants';

interface TxnRow {
  id: string;
  reference: string;
  branch_id: string;
  cashier_id: string;
  session_id: string;
  datetime: string;
  type: 'sale' | 'refund';
  original_txn_id: string | null;
  payment_method: string;
  subtotal: number;
  discount_total: number;
  grand_total: number;
  tendered: number | null;
  change_due: number | null;
  status: string;
  authorised_by: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
}

function toTransactionSummary(row: TxnRow): Transaction {
  return {
    id: row.id,
    reference: row.reference,
    branchId: row.branch_id,
    cashierId: row.cashier_id,
    sessionId: row.session_id,
    datetime: row.datetime,
    type: row.type,
    originalTxnId: row.original_txn_id,
    paymentMethod: row.payment_method as Transaction['paymentMethod'],
    subtotal: row.subtotal,
    discountTotal: row.discount_total,
    grandTotal: row.grand_total,
    tendered: row.tendered,
    changeDue: row.change_due,
    status: row.status as Transaction['status'],
    authorisedBy: row.authorised_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: row.sync_status as Transaction['syncStatus'],
  };
}

export class ReportService {
  constructor(private readonly db: DB) {}

  salesReport(start: string, end: string, branchId: string): SalesReport {
    const params = { start, end, branch: branchId };

    const totals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'sale' THEN grand_total ELSE -grand_total END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN type = 'sale' THEN 1 ELSE 0 END), 0) AS txns
         FROM transactions
         WHERE status = 'completed' AND branch_id = @branch AND datetime >= @start AND datetime < @end`,
      )
      .get(params) as { revenue: number; txns: number };

    const byCategory = this.db
      .prepare(
        `SELECT pr.category AS category,
                SUM(CASE WHEN t.type = 'sale' THEN ti.line_total ELSE -ti.line_total END) AS total
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         JOIN products pr ON pr.id = ti.product_id
         WHERE t.status = 'completed' AND t.branch_id = @branch AND t.datetime >= @start AND t.datetime < @end
         GROUP BY pr.category
         ORDER BY total DESC`,
      )
      .all(params) as { category: string; total: number }[];

    const topProducts = this.db
      .prepare(
        `SELECT ti.product_id AS productId, ti.product_name AS name,
                SUM(CASE WHEN t.type = 'sale' THEN ti.quantity ELSE -ti.quantity END) AS quantity,
                SUM(CASE WHEN t.type = 'sale' THEN ti.line_total ELSE -ti.line_total END) AS total
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         WHERE t.status = 'completed' AND t.branch_id = @branch AND t.datetime >= @start AND t.datetime < @end
         GROUP BY ti.product_id
         ORDER BY total DESC
         LIMIT 10`,
      )
      .all(params) as { productId: string; name: string; quantity: number; total: number }[];

    return {
      start,
      end,
      totalRevenue: totals.revenue,
      transactionCount: totals.txns,
      byCategory,
      topProducts,
    };
  }

  transactions(branchId: string, filter: TransactionFilter): Transaction[] {
    const clauses = ["branch_id = @branch", "status != 'held'"];
    const params: Record<string, unknown> = { branch: branchId, limit: filter.limit ?? 200 };
    if (filter.start) {
      clauses.push('datetime >= @start');
      params.start = filter.start;
    }
    if (filter.end) {
      clauses.push('datetime < @end');
      params.end = filter.end;
    }
    if (filter.type) {
      clauses.push('type = @type');
      params.type = filter.type;
    }
    if (filter.query) {
      clauses.push('reference LIKE @q');
      params.q = `%${filter.query}%`;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM transactions WHERE ${clauses.join(' AND ')} ORDER BY datetime DESC LIMIT @limit`,
      )
      .all(params) as TxnRow[];
    return rows.map(toTransactionSummary);
  }

  stockMovements(
    branchId: string,
    filter: { start?: string; end?: string; type?: StockMovementType; limit?: number },
  ): StockMovementView[] {
    const clauses = ['m.branch_id = @branch'];
    const params: Record<string, unknown> = { branch: branchId, limit: filter.limit ?? 300 };
    if (filter.start) {
      clauses.push('m.datetime >= @start');
      params.start = filter.start;
    }
    if (filter.end) {
      clauses.push('m.datetime < @end');
      params.end = filter.end;
    }
    if (filter.type) {
      clauses.push('m.type = @type');
      params.type = filter.type;
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.product_id AS productId, p.name AS productName, m.type, m.quantity, m.reason,
                COALESCE(u.username, m.user_id) AS userName, m.datetime
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY m.datetime DESC LIMIT @limit`,
      )
      .all(params) as StockMovementView[];
    return rows;
  }
}
