/** Order-planning IPC handlers (M11). Manager/administrator only. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { ORDER_PLAN_STATUSES } from '@shared/constants';

const tokenStr = z.string().min(1);
const id = z.string().min(1);
/** Money crosses IPC as INTEGER minor units. */
const money = z.number().int().min(0);
const quantity = z.number().positive();

const catalogueInput = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(120),
  supplier: z.string().max(120).nullish(),
  unitOfOrder: z.string().min(1).max(20),
  unitCost: money,
  packSize: z.number().positive().nullish(),
  productId: id.nullish(),
  notes: z.string().max(500).nullish(),
});

const cataloguePatch = z.object({
  code: z.string().min(1).max(16).optional(),
  name: z.string().min(1).max(120).optional(),
  supplier: z.string().max(120).nullish(),
  unitOfOrder: z.string().min(1).max(20).optional(),
  unitCost: money.optional(),
  packSize: z.number().positive().nullish(),
  productId: id.nullish(),
  notes: z.string().max(500).nullish(),
  active: z.boolean().optional(),
});

const planInput = z.object({
  title: z.string().min(1).max(120),
  budget: money.nullish(),
  notes: z.string().max(1000).nullish(),
});

const planPatch = z.object({
  title: z.string().min(1).max(120).optional(),
  budget: money.nullish(),
  notes: z.string().max(1000).nullish(),
});

const lineInput = z.object({
  code: z.string().max(16).optional(),
  catalogueId: id.optional(),
  quantity,
  unitCost: money.optional(),
  name: z.string().max(120).optional(),
  unitOfOrder: z.string().max(20).optional(),
  notes: z.string().max(500).nullish(),
  adHoc: z.boolean().optional(),
});

const linePatch = z.object({
  quantity: quantity.optional(),
  unitCost: money.optional(),
  actualQuantity: z.number().min(0).nullish(),
  actualUnitCost: money.nullish(),
  notes: z.string().max(500).nullish(),
});

const closeInput = z.object({
  budget: money.nullish(),
  actualTotal: money.optional(),
  notes: z.string().max(1000).nullish(),
});

export function registerOrderHandlers(): void {
  // ---- order price list ----

  registerHandler('order:catalogueList', (req) => {
    const { token, includeInactive } = z
      .object({ token: tokenStr, includeInactive: z.boolean().optional() })
      .parse(req);
    const { sessions, orders } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return orders.listCatalogue(includeInactive ?? false);
  });

  registerHandler('order:catalogueSearch', (req) => {
    const { token, query } = z.object({ token: tokenStr, query: z.string().max(120) }).parse(req);
    const { sessions, orders } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return orders.searchCatalogue(query);
  });

  registerHandler('order:catalogueFindByCode', (req) => {
    const { token, code } = z.object({ token: tokenStr, code: z.string().min(1).max(16) }).parse(req);
    const { sessions, orders } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return orders.findByCode(code);
  });

  registerHandler('order:catalogueCreate', (req) => {
    const { token, input } = z.object({ token: tokenStr, input: catalogueInput }).parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.createCatalogueItem(input, session.userId);
  });

  registerHandler('order:catalogueUpdate', (req) => {
    const { token, id: itemId, patch } = z
      .object({ token: tokenStr, id, patch: cataloguePatch })
      .parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.updateCatalogueItem(itemId, patch, session.userId);
  });

  registerHandler('order:costHistory', (req) => {
    const { token, catalogueId } = z.object({ token: tokenStr, catalogueId: id }).parse(req);
    const { sessions, orders } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return orders.costHistory(catalogueId);
  });

  // ---- order plans ----

  registerHandler('order:planList', (req) => {
    const { token, status, limit } = z
      .object({
        token: tokenStr,
        status: z.enum(ORDER_PLAN_STATUSES).optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .parse(req);
    const { sessions, orders, branches } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return orders.listPlans(branches.getCurrentId(), { status, limit });
  });

  registerHandler('order:planGet', (req) => {
    const { token, id: planId } = z.object({ token: tokenStr, id }).parse(req);
    const { sessions, orders } = getServices();
    authorize(sessions, token, 'manager', 'administrator');
    return orders.getPlan(planId);
  });

  registerHandler('order:planCreate', (req) => {
    const { token, input } = z.object({ token: tokenStr, input: planInput }).parse(req);
    const { sessions, orders, branches } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.createPlan(input, branches.getCurrentId(), session.userId);
  });

  registerHandler('order:planUpdate', (req) => {
    const { token, id: planId, patch } = z.object({ token: tokenStr, id, patch: planPatch }).parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.updatePlan(planId, patch, session.userId);
  });

  registerHandler('order:planAddLine', (req) => {
    const { token, planId, input } = z
      .object({ token: tokenStr, planId: id, input: lineInput })
      .parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.addLine(planId, input, session.userId);
  });

  registerHandler('order:planUpdateLine', (req) => {
    const { token, lineId, patch } = z
      .object({ token: tokenStr, lineId: id, patch: linePatch })
      .parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.updateLine(lineId, patch, session.userId);
  });

  registerHandler('order:planRemoveLine', (req) => {
    const { token, lineId } = z.object({ token: tokenStr, lineId: id }).parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.removeLine(lineId, session.userId);
  });

  registerHandler('order:planSetStatus', (req) => {
    const { token, id: planId, status } = z
      .object({ token: tokenStr, id, status: z.enum(['draft', 'shopping', 'cancelled']) })
      .parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.setStatus(planId, status, session.userId);
  });

  registerHandler('order:planClose', (req) => {
    const { token, id: planId, input } = z
      .object({ token: tokenStr, id, input: closeInput })
      .parse(req);
    const { sessions, orders } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.closePlan(planId, input, session.userId);
  });

  registerHandler('order:planDuplicate', (req) => {
    const { token, id: planId, title } = z
      .object({ token: tokenStr, id, title: z.string().min(1).max(120).optional() })
      .parse(req);
    const { sessions, orders, branches } = getServices();
    const session = authorize(sessions, token, 'manager', 'administrator');
    return orders.duplicatePlan(planId, branches.getCurrentId(), session.userId, title);
  });
}
