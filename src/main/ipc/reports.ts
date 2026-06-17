/** Reporting IPC handlers (M6). Manager/administrator only. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { STOCK_MOVEMENT_TYPES } from '@shared/constants';

const tokenStr = z.string().min(1);

export function registerReportHandlers(): void {
  registerHandler('report:sales', (req) => {
    const { token, start, end } = z
      .object({ token: tokenStr, start: z.string().min(1), end: z.string().min(1) })
      .parse(req);
    const { sessions, reports, branches } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return reports.salesReport(start, end, branches.getCurrentId());
  });

  registerHandler('report:transactions', (req) => {
    const { token, filter } = z
      .object({
        token: tokenStr,
        filter: z.object({
          start: z.string().optional(),
          end: z.string().optional(),
          type: z.enum(['sale', 'refund']).optional(),
          query: z.string().optional(),
          limit: z.number().int().positive().max(1000).optional(),
        }),
      })
      .parse(req);
    const { sessions, reports, branches } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return reports.transactions(branches.getCurrentId(), filter);
  });

  registerHandler('report:stockMovements', (req) => {
    const { token, start, end, type, limit } = z
      .object({
        token: tokenStr,
        start: z.string().optional(),
        end: z.string().optional(),
        type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
        limit: z.number().int().positive().max(2000).optional(),
      })
      .parse(req);
    const { sessions, reports, branches } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return reports.stockMovements(branches.getCurrentId(), { start, end, type, limit });
  });
}
