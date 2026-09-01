import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices } from '../helpers/db';
import type { Services } from '../../../src/main/services';
import type { DB } from '../../../src/main/db/connection';

/** K1 = 100 ngwee; all money below is in minor units. */
describe('OrderPlanningService (M11)', () => {
  let db: DB;
  let services: Services;
  let branchId: string;
  let ACTOR: string;

  beforeEach(async () => {
    const made = makeServices();
    db = made.db;
    services = made.services;
    branchId = services.branches.getCurrentId();
    // order_plans.created_by references users(id), so the actor must be a real user.
    ACTOR = (await services.users.create({ username: 'owner', password: 'ownerpass1', role: 'manager' }, 'system')).id;
  });

  function beef(): string {
    return services.orders.createCatalogueItem(
      { code: 'BF01', name: 'Beef carcass', unitOfOrder: 'kg', unitCost: 8500, supplier: 'Chibolya Abattoir' },
      ACTOR,
    ).id;
  }

  function flour(): string {
    return services.orders.createCatalogueItem(
      { code: 'FL10', name: 'Bread flour 25kg', unitOfOrder: 'bag', unitCost: 42000 },
      ACTOR,
    ).id;
  }

  // ------------------------------------------------------------ price list

  describe('order price list', () => {
    it('saves an item under an uppercased code and finds it case-insensitively', () => {
      services.orders.createCatalogueItem(
        { code: 'bf01', name: 'Beef carcass', unitOfOrder: 'kg', unitCost: 8500 },
        ACTOR,
      );
      const found = services.orders.findByCode('Bf01');
      expect(found?.code).toBe('BF01');
      expect(found?.unitCost).toBe(8500);
    });

    it('rejects a duplicate code regardless of case', () => {
      beef();
      expect(() =>
        services.orders.createCatalogueItem(
          { code: 'bf01', name: 'Something else', unitOfOrder: 'kg', unitCost: 100 },
          ACTOR,
        ),
      ).toThrow(/already used/i);
    });

    it('rejects codes with spaces and negative costs', () => {
      expect(() =>
        services.orders.createCatalogueItem(
          { code: 'BF 01', name: 'Beef', unitOfOrder: 'kg', unitCost: 100 },
          ACTOR,
        ),
      ).toThrow(/no spaces/i);
      expect(() =>
        services.orders.createCatalogueItem({ code: 'X1', name: 'Beef', unitOfOrder: 'kg', unitCost: -1 }, ACTOR),
      ).toThrow(/negative/i);
    });

    it('records an append-only history entry when the cost changes', () => {
      const id = beef();
      services.orders.updateCatalogueItem(id, { unitCost: 9200 }, ACTOR);
      services.orders.updateCatalogueItem(id, { name: 'Beef carcass (fore)' }, ACTOR); // no cost change
      const history = services.orders.costHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ oldCost: 8500, newCost: 9200 });
      expect(() => db.prepare('DELETE FROM order_cost_history').run()).toThrow(/append-only/);
    });

    it('hides deactivated items from the default list and search', () => {
      const id = beef();
      services.orders.updateCatalogueItem(id, { active: false }, ACTOR);
      expect(services.orders.listCatalogue()).toHaveLength(0);
      expect(services.orders.listCatalogue(true)).toHaveLength(1);
      expect(services.orders.searchCatalogue('Beef')).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------- plans

  describe('planning an order', () => {
    it('prices a line from the preset cost when a code is typed', () => {
      beef();
      const plan = services.orders.createPlan({ title: 'Friday order', budget: 500000 }, branchId, ACTOR);
      const withLine = services.orders.addLine(plan.id, { code: 'bf01', quantity: 12 }, ACTOR);

      expect(withLine.items).toHaveLength(1);
      expect(withLine.items![0]).toMatchObject({
        code: 'BF01',
        name: 'Beef carcass',
        unitOfOrder: 'kg',
        quantity: 12,
        unitCost: 8500,
        lineTotal: 102000, // 12kg * K85.00
      });
      expect(withLine.plannedTotal).toBe(102000);
    });

    it('totals several lines and gives every plan a reference', () => {
      beef();
      flour();
      const plan = services.orders.createPlan({ title: 'Weekly order' }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 20 }, ACTOR); // 170000
      const final = services.orders.addLine(plan.id, { code: 'FL10', quantity: 4 }, ACTOR); // 168000

      expect(final.plannedTotal).toBe(338000);
      expect(final.reference).toMatch(/^ORD-[A-Z0-9]{4}-00001$/);
      expect(services.orders.createPlan({ title: 'Next' }, branchId, ACTOR).reference).toMatch(/-00002$/);
    });

    it('refuses an unknown code and a zero quantity', () => {
      const plan = services.orders.createPlan({ title: 'Order' }, branchId, ACTOR);
      expect(() => services.orders.addLine(plan.id, { code: 'NOPE', quantity: 1 }, ACTOR)).toThrow(
        /NOPE/,
      );
      beef();
      expect(() => services.orders.addLine(plan.id, { code: 'BF01', quantity: 0 }, ACTOR)).toThrow(
        /greater than zero/i,
      );
    });

    it('accepts a one-off line that is not on the price list', () => {
      const plan = services.orders.createPlan({ title: 'Order' }, branchId, ACTOR);
      const withLine = services.orders.addLine(
        { ...plan }.id,
        { adHoc: true, code: 'MISC', name: 'Charcoal', unitOfOrder: 'bag', quantity: 3, unitCost: 5000 },
        ACTOR,
      );
      expect(withLine.items![0]).toMatchObject({ code: 'MISC', catalogueId: null, lineTotal: 15000 });
      expect(withLine.plannedTotal).toBe(15000);
    });

    it('re-totals when a line is edited or removed', () => {
      beef();
      const plan = services.orders.createPlan({ title: 'Order' }, branchId, ACTOR);
      const one = services.orders.addLine(plan.id, { code: 'BF01', quantity: 10 }, ACTOR);
      expect(one.plannedTotal).toBe(85000);

      const edited = services.orders.updateLine(one.items![0].id, { quantity: 15 }, ACTOR);
      expect(edited.plannedTotal).toBe(127500);

      const removed = services.orders.removeLine(one.items![0].id, ACTOR);
      expect(removed.plannedTotal).toBe(0);
      expect(removed.items).toHaveLength(0);
    });

    it('keeps the planned cost even after the price list changes (snapshot)', () => {
      const id = beef();
      const plan = services.orders.createPlan({ title: 'Order' }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 10 }, ACTOR);
      services.orders.updateCatalogueItem(id, { unitCost: 9500 }, ACTOR);

      const reloaded = services.orders.getPlan(plan.id);
      expect(reloaded.items![0].unitCost).toBe(8500);
      expect(reloaded.plannedTotal).toBe(85000);
    });
  });

  // ------------------------------------------------------- reconciliation

  describe('shopping and reconciling', () => {
    function planWithTwoLines(): { planId: string; lineIds: string[] } {
      beef();
      flour();
      const plan = services.orders.createPlan({ title: 'Friday order', budget: 400000 }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 20 }, ACTOR); // 170000
      const full = services.orders.addLine(plan.id, { code: 'FL10', quantity: 4 }, ACTOR); // 168000
      return { planId: plan.id, lineIds: full.items!.map((i) => i.id) };
    }

    it('counts a line with no actuals recorded as going to plan', () => {
      const { planId } = planWithTwoLines();
      expect(services.orders.actualSoFar(planId)).toBe(338000);
    });

    it('re-prices a line from what was really paid', () => {
      const { planId, lineIds } = planWithTwoLines();
      // Beef came in at K90.00/kg and only 18kg was available.
      const updated = services.orders.updateLine(
        lineIds[0],
        { actualQuantity: 18, actualUnitCost: 9000 },
        ACTOR,
      );
      expect(updated.items![0].actualLineTotal).toBe(162000);
      expect(services.orders.actualSoFar(planId)).toBe(162000 + 168000);
    });

    it('falls back to the planned quantity when only the price is recorded', () => {
      const { planId, lineIds } = planWithTwoLines();
      services.orders.updateLine(lineIds[1], { actualUnitCost: 45000 }, ACTOR);
      expect(services.orders.actualSoFar(planId)).toBe(170000 + 180000);
    });

    it('treats a zero actual quantity as "not bought"', () => {
      const { planId, lineIds } = planWithTwoLines();
      services.orders.updateLine(lineIds[1], { actualQuantity: 0 }, ACTOR);
      expect(services.orders.actualSoFar(planId)).toBe(170000);
    });

    it('closes the plan with the spend and the change to hand back', () => {
      const { planId, lineIds } = planWithTwoLines();
      services.orders.setStatus(planId, 'shopping', ACTOR);
      services.orders.updateLine(lineIds[0], { actualQuantity: 18, actualUnitCost: 9000 }, ACTOR); // 162000
      const closed = services.orders.closePlan(planId, {}, ACTOR); // budget 400000, actual 330000

      expect(closed.status).toBe('closed');
      expect(closed.actualTotal).toBe(330000);
      expect(closed.changeReturned).toBe(70000);
      expect(closed.closedBy).toBe(ACTOR);
      expect(closed.closedAt).toBeTruthy();
    });

    it('accepts an overriding total and reports an overspend as negative change', () => {
      const { planId } = planWithTwoLines();
      const closed = services.orders.closePlan(planId, { actualTotal: 415000 }, ACTOR);
      expect(closed.actualTotal).toBe(415000);
      expect(closed.changeReturned).toBe(-15000);
    });

    it('records extra cash taken at closing time', () => {
      const { planId } = planWithTwoLines();
      const closed = services.orders.closePlan(planId, { budget: 350000, actualTotal: 338000 }, ACTOR);
      expect(closed.budget).toBe(350000);
      expect(closed.changeReturned).toBe(12000);
    });

    it('will not close an empty plan', () => {
      const plan = services.orders.createPlan({ title: 'Empty' }, branchId, ACTOR);
      expect(() => services.orders.closePlan(plan.id, {}, ACTOR)).toThrow(/at least one item/i);
    });
  });

  // ------------------------------------------------------ permanent record

  describe('a closed plan is a permanent record', () => {
    function closedPlan(): string {
      beef();
      const plan = services.orders.createPlan({ title: 'Order', budget: 100000 }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 10 }, ACTOR);
      return services.orders.closePlan(plan.id, {}, ACTOR).id;
    }

    it('refuses every edit through the service', () => {
      const planId = closedPlan();
      const lineId = services.orders.getPlan(planId).items![0].id;
      expect(() => services.orders.updatePlan(planId, { title: 'Changed' }, ACTOR)).toThrow(/closed/i);
      expect(() => services.orders.addLine(planId, { code: 'BF01', quantity: 1 }, ACTOR)).toThrow(/closed/i);
      expect(() => services.orders.updateLine(lineId, { quantity: 99 }, ACTOR)).toThrow(/closed/i);
      expect(() => services.orders.removeLine(lineId, ACTOR)).toThrow(/closed/i);
      expect(() => services.orders.closePlan(planId, {}, ACTOR)).toThrow(/closed/i);
      expect(() => services.orders.setStatus(planId, 'draft', ACTOR)).toThrow(/closed/i);
    });

    it('blocks direct SQL edits and deletes too', () => {
      const planId = closedPlan();
      expect(() =>
        db.prepare('UPDATE order_plans SET actual_total = 1 WHERE id = ?').run(planId),
      ).toThrow(/no longer be changed/);
      expect(() => db.prepare('DELETE FROM order_plans WHERE id = ?').run(planId)).toThrow(
        /no longer be deleted/,
      );
      expect(() => db.prepare('UPDATE order_plan_items SET quantity = 1 WHERE plan_id = ?').run(planId)).toThrow(
        /no longer be changed/,
      );
      expect(() => db.prepare('DELETE FROM order_plan_items WHERE plan_id = ?').run(planId)).toThrow(
        /no longer be changed/,
      );
    });

    it('still lets the sync engine stamp sync_status', () => {
      const planId = closedPlan();
      expect(() =>
        db.prepare("UPDATE order_plans SET sync_status = 'synced' WHERE id = ?").run(planId),
      ).not.toThrow();
      expect(() =>
        db.prepare("UPDATE order_plan_items SET sync_status = 'synced' WHERE plan_id = ?").run(planId),
      ).not.toThrow();
    });

    it('cancelling also freezes the plan', () => {
      beef();
      const plan = services.orders.createPlan({ title: 'Abandoned' }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 1 }, ACTOR);
      const cancelled = services.orders.setStatus(plan.id, 'cancelled', ACTOR);
      expect(cancelled.status).toBe('cancelled');
      expect(() => services.orders.updatePlan(plan.id, { title: 'x' }, ACTOR)).toThrow(/cancelled/i);
    });
  });

  // -------------------------------------------------------------- reorder

  describe('duplicating a plan', () => {
    it('copies the lines into a new draft at today’s costs', () => {
      const beefId = beef();
      flour();
      const plan = services.orders.createPlan({ title: 'Weekly order', budget: 400000 }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 20 }, ACTOR);
      services.orders.addLine(plan.id, { code: 'FL10', quantity: 4 }, ACTOR);
      services.orders.closePlan(plan.id, {}, ACTOR);

      services.orders.updateCatalogueItem(beefId, { unitCost: 9000 }, ACTOR);
      const copy = services.orders.duplicatePlan(plan.id, branchId, ACTOR);

      expect(copy.status).toBe('draft');
      expect(copy.title).toBe('Weekly order (copy)');
      expect(copy.budget).toBe(400000);
      expect(copy.id).not.toBe(plan.id);
      expect(copy.items).toHaveLength(2);
      expect(copy.items![0]).toMatchObject({ code: 'BF01', quantity: 20, unitCost: 9000 });
      expect(copy.plannedTotal).toBe(180000 + 168000);
      // The original is untouched.
      expect(services.orders.getPlan(plan.id).plannedTotal).toBe(338000);
    });

    it('copies a retired item across as a one-off line at its old cost', () => {
      const beefId = beef();
      const plan = services.orders.createPlan({ title: 'Order' }, branchId, ACTOR);
      services.orders.addLine(plan.id, { code: 'BF01', quantity: 10 }, ACTOR);
      services.orders.updateCatalogueItem(beefId, { active: false }, ACTOR);

      const copy = services.orders.duplicatePlan(plan.id, branchId, ACTOR, 'Retry');
      expect(copy.title).toBe('Retry');
      expect(copy.items![0]).toMatchObject({ code: 'BF01', catalogueId: null, unitCost: 8500 });
    });
  });

  // ----------------------------------------------------------------- list

  it('lists plans newest-first with their line counts, filtered by status', () => {
    beef();
    const a = services.orders.createPlan({ title: 'First' }, branchId, ACTOR);
    services.orders.addLine(a.id, { code: 'BF01', quantity: 1 }, ACTOR);
    services.orders.closePlan(a.id, {}, ACTOR);
    services.orders.createPlan({ title: 'Second' }, branchId, ACTOR);

    const all = services.orders.listPlans(branchId);
    expect(all.map((p) => p.title)).toEqual(['Second', 'First']);
    expect(all[1].itemCount).toBe(1);
    expect(all[1].createdByName).toBe('owner');
    expect(services.orders.listPlans(branchId, { status: 'closed' }).map((p) => p.title)).toEqual(['First']);
  });
});
