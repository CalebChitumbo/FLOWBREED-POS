import { openDatabase, type DB } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { buildServices, type Services } from '../../../src/main/services';

/** Build a fully migrated in-memory DB plus a fresh service container for tests. */
export function makeServices(): { db: DB; services: Services } {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return { db, services: buildServices(db) };
}
