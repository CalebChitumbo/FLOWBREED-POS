/** Opening-catalogue import IPC (M2). Manager or administrator only: it writes
 *  the product catalogue. `plan` is read-only, so the screen can show what the
 *  import would do before anyone commits to it. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { HQ_CATALOGUE, HQ_CATALOGUE_SOURCE } from '../catalogue/hq-catalogue';

const tokenOnly = z.object({ token: z.string().min(1) });

export function registerCatalogueHandlers(): void {
  registerHandler('catalogue:plan', (req) => {
    const { token } = tokenOnly.parse(req);
    authorize(getServices().sessions, token, 'manager', 'administrator');
    const plan = getServices().catalogue.plan();
    return {
      toCreate: plan.toCreate,
      toAddBarcodes: plan.toAddBarcodes,
      unchanged: plan.unchanged,
      withoutBarcode: plan.withoutBarcode,
      conflicts: plan.conflicts,
      source: HQ_CATALOGUE_SOURCE,
      total: HQ_CATALOGUE.length,
    };
  });

  registerHandler('catalogue:import', (req) => {
    const { token } = tokenOnly.parse(req);
    const session = authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().catalogue.import(session.userId);
  });
}
