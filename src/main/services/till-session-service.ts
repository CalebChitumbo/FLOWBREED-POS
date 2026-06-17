/**
 * Till sessions (FT). A cashier opens a session with an opening cash float at the
 * start of a shift; all their sales are tagged to it. Closing computes a summary
 * (sales by payment method, transaction count, expected cash, discounts, voids).
 */
import type { DB } from '../db/connection';
import type { TillSession, TillSessionTotals } from '@shared/types/domain';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { Errors } from '../errors';
import type { AuditService } from './audit-service';
import type { OutboxService } from './outbox-service';

interface SessionRow {
  id: string;
  cashier_id: string;
  branch_id: string;
  open_time: string;
  close_time: string | null;
  opening_float: number;
  status: 'open' | 'closed';
  total_sales: number | null;
  total_cash: number | null;
  total_card: number | null;
  total_mobile: number | null;
  txn_count: number | null;
  discount_total: number | null;
  void_count: number | null;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): TillSession {
  const session: TillSession = {
    id: row.id,
    cashierId: row.cashier_id,
    branchId: row.branch_id,
    openTime: row.open_time,
    closeTime: row.close_time,
    openingFloat: row.opening_float,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.status === 'closed') {
    session.totals = {
      totalSales: row.total_sales ?? 0,
      totalCash: row.total_cash ?? 0,
      totalCard: row.total_card ?? 0,
      totalMobile: row.total_mobile ?? 0,
      txnCount: row.txn_count ?? 0,
      discountTotal: row.discount_total ?? 0,
      voidCount: row.void_count ?? 0,
    };
  }
  return session;
}

export class TillSessionService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  getById(id: string): TillSession | undefined {
    const row = this.db.prepare('SELECT * FROM till_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : undefined;
  }

  getOpenForCashier(cashierId: string): TillSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM till_sessions WHERE cashier_id = ? AND status = 'open' ORDER BY open_time DESC")
      .get(cashierId) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listOpen(): TillSession[] {
    const rows = this.db
      .prepare("SELECT * FROM till_sessions WHERE status = 'open' ORDER BY open_time")
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  open(cashierId: string, branchId: string, openingFloat: number): TillSession {
    if (openingFloat < 0) throw Errors.validation('Opening float cannot be negative.');
    if (this.getOpenForCashier(cashierId)) {
      throw Errors.conflict('You already have an open till session.');
    }
    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO till_sessions
             (id, cashier_id, branch_id, open_time, opening_float, status, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'pending')`,
        )
        .run(id, cashierId, branchId, now, openingFloat, now, now);
      this.outbox.enqueue('till_session', id, 'create', { id, cashierId, branchId, openingFloat });
      this.audit.record({
        userId: cashierId,
        action: 'session_open',
        entityType: 'till_session',
        entityId: id,
        newValue: { openingFloat },
      });
    })();
    return this.getById(id)!;
  }

  /** Compute live totals for a session from its transactions. */
  computeTotals(sessionId: string): TillSessionTotals {
    const sumByMethod = (method: string): number => {
      const row = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN type = 'sale' THEN grand_total ELSE -grand_total END), 0) AS net
           FROM transactions
           WHERE session_id = ? AND status = 'completed' AND payment_method = ?`,
        )
        .get(sessionId, method) as { net: number };
      return row.net;
    };
    const totalCash = sumByMethod('cash');
    const totalCard = sumByMethod('card');
    const totalMobile = sumByMethod('mobile_mtn') + sumByMethod('mobile_airtel');
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'sale' THEN grand_total ELSE -grand_total END), 0) AS net_sales,
           COALESCE(SUM(CASE WHEN type = 'sale' THEN discount_total ELSE 0 END), 0) AS discounts,
           COALESCE(SUM(CASE WHEN type = 'sale' AND status = 'completed' THEN 1 ELSE 0 END), 0) AS txns,
           COALESCE(SUM(CASE WHEN status = 'voided' THEN 1 ELSE 0 END), 0) AS voids
         FROM transactions WHERE session_id = ?`,
      )
      .get(sessionId) as { net_sales: number; discounts: number; txns: number; voids: number };
    return {
      totalSales: agg.net_sales,
      totalCash,
      totalCard,
      totalMobile,
      txnCount: agg.txns,
      discountTotal: agg.discounts,
      voidCount: agg.voids,
    };
  }

  close(sessionId: string, actorId: string): TillSession {
    const existing = this.db.prepare('SELECT * FROM till_sessions WHERE id = ?').get(sessionId) as
      | SessionRow
      | undefined;
    if (!existing) throw Errors.notFound('till session');
    if (existing.status === 'closed') throw Errors.conflict('This session is already closed.');

    const totals = this.computeTotals(sessionId);
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE till_sessions SET
             close_time = ?, status = 'closed',
             total_sales = ?, total_cash = ?, total_card = ?, total_mobile = ?,
             txn_count = ?, discount_total = ?, void_count = ?,
             updated_at = ?, sync_status = 'pending'
           WHERE id = ?`,
        )
        .run(
          now,
          totals.totalSales,
          totals.totalCash,
          totals.totalCard,
          totals.totalMobile,
          totals.txnCount,
          totals.discountTotal,
          totals.voidCount,
          now,
          sessionId,
        );
      this.outbox.enqueue('till_session', sessionId, 'update', { id: sessionId, status: 'closed', totals });
      this.audit.record({
        userId: actorId,
        action: 'session_close',
        entityType: 'till_session',
        entityId: sessionId,
        newValue: totals,
      });
    })();
    return this.getById(sessionId)!;
  }
}
