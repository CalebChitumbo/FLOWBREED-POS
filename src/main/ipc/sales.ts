/** Till-session, sale/refund, and printing IPC handlers (M3). */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { getPrinter } from '../printer/printer-service';
import { Errors } from '../errors';
import { PAYMENT_METHODS } from '@shared/constants';

const tokenStr = z.string().min(1);

const saleInput = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().positive(),
        lineDiscount: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
  paymentMethod: z.enum(PAYMENT_METHODS),
  tendered: z.number().int().min(0).optional(),
  transactionDiscount: z.number().int().min(0).optional(),
  authorisedBy: z.string().optional(),
});

const refundInput = z.object({
  originalTxnId: z.string().min(1),
  items: z
    .array(z.object({ productId: z.string().min(1), quantity: z.number().positive() }))
    .min(1),
});

export function registerSaleHandlers(): void {
  // ---- Till sessions ----
  registerHandler('session:open', (req) => {
    const { token, openingFloat } = z
      .object({ token: tokenStr, openingFloat: z.number().int().min(0) })
      .parse(req);
    const session = authorize(getServices().sessions, token);
    const branchId = getServices().branches.getCurrentId();
    return getServices().tills.open(session.userId, branchId, openingFloat);
  });

  registerHandler('session:current', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const session = authorize(getServices().sessions, token);
    return getServices().tills.getOpenForCashier(session.userId) ?? null;
  });

  registerHandler('session:close', (req) => {
    const { token, sessionId } = z.object({ token: tokenStr, sessionId: z.string().optional() }).parse(req);
    const { sessions, tills } = getServices();
    const session = authorize(sessions, token);
    let targetId = sessionId;
    if (!targetId) {
      const own = tills.getOpenForCashier(session.userId);
      if (!own) throw Errors.notFound('open session');
      targetId = own.id;
    } else {
      const own = tills.getOpenForCashier(session.userId);
      if (!own || own.id !== targetId) {
        authorize(sessions, token, 'manager', 'administrator'); // closing someone else's session
      }
    }
    return tills.close(targetId, session.userId);
  });

  registerHandler('session:listOpen', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, tills, users } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return tills.listOpen().map((s) => ({
      ...s,
      cashierName: users.findById(s.cashierId)?.username ?? s.cashierId,
    }));
  });

  registerHandler('session:summary', (req) => {
    const { token, sessionId } = z.object({ token: tokenStr, sessionId: z.string().min(1) }).parse(req);
    authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().tills.computeTotals(sessionId);
  });

  // ---- Sales ----
  registerHandler('sale:create', (req) => {
    const { token, input } = z.object({ token: tokenStr, input: saleInput }).parse(req);
    const session = authorize(getServices().sessions, token);
    return getServices().sales.create(input, { userId: session.userId, username: session.username });
  });

  registerHandler('sale:refund', (req) => {
    const { token, input } = z.object({ token: tokenStr, input: refundInput }).parse(req);
    const session = authorize(getServices().sessions, token);
    return getServices().sales.refund(input, { userId: session.userId, username: session.username });
  });

  registerHandler('sale:get', (req) => {
    const { token, id } = z.object({ token: tokenStr, id: z.string().min(1) }).parse(req);
    authorize(getServices().sessions, token);
    const txn = getServices().sales.get(id);
    if (!txn) throw Errors.notFound('transaction');
    return txn;
  });

  // ---- Printing ----
  registerHandler('print:receipt', async (req) => {
    const { token, transactionId } = z
      .object({ token: tokenStr, transactionId: z.string().min(1) })
      .parse(req);
    const session = authorize(getServices().sessions, token);
    const txn = getServices().sales.get(transactionId);
    if (!txn) throw Errors.notFound('transaction');
    const receipt = getServices().sales.receiptFor(transactionId, session.username);
    await getPrinter().printReceipt(receipt, {
      kickDrawer: txn.paymentMethod === 'cash' && txn.type === 'sale',
    });
    return { ok: true as const };
  });

  registerHandler('print:reprintLast', async (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    authorize(getServices().sessions, token);
    const last = getPrinter().getLast();
    if (!last) throw Errors.notFound('recent receipt');
    await getPrinter().printReceipt(last, { kickDrawer: false });
    return { ok: true as const };
  });
}
