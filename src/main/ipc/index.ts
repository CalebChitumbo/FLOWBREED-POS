/**
 * Registers all IPC handlers. As milestones add domains (auth, product, sale, ...)
 * their handler modules are wired up here.
 */
import { app } from 'electron';
import { registerHandler } from './registry';
import { getDb } from '../db/connection';
import { getSchemaVersion } from '../db/migrate';
import { registerAuthHandlers } from './auth';
import { registerUserHandlers } from './users';
import { registerProductHandlers } from './products';
import { registerSaleHandlers } from './sales';
import { registerInventoryHandlers } from './inventory';
import { registerReportHandlers } from './reports';
import { registerOrderHandlers } from './orders';
import { registerSyncHandlers } from './sync';
import { registerSystemHandlers } from './system';

export function registerAllHandlers(): void {
  registerHandler('app:info', () => ({
    name: 'Flowbreeds POS',
    version: app.getVersion(),
    schemaVersion: getSchemaVersion(getDb()),
    platform: process.platform,
  }));

  registerHandler('db:ping', () => {
    const row = getDb()
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'")
      .get() as { c: number };
    return { ok: true as const, tables: row.c };
  });

  registerAuthHandlers();
  registerUserHandlers();
  registerProductHandlers();
  registerSaleHandlers();
  registerInventoryHandlers();
  registerReportHandlers();
  registerOrderHandlers();
  registerSyncHandlers();
  registerSystemHandlers();
}
