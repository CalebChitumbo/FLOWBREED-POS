/** Sync status + manual-trigger IPC handlers (M7). Any authenticated user. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { getSyncEngine } from '../sync';

const tokenOnly = z.object({ token: z.string().min(1) });

export function registerSyncHandlers(): void {
  registerHandler('sync:status', (req) => {
    const { token } = tokenOnly.parse(req);
    authorize(getServices().sessions, token);
    return getSyncEngine().status();
  });

  registerHandler('sync:now', async (req) => {
    const { token } = tokenOnly.parse(req);
    authorize(getServices().sessions, token);
    return getSyncEngine().tick();
  });
}
