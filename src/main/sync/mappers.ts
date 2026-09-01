/** Entity <-> sync mapping helpers. */

const snakeToCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Convert a snake_case SQLite row into a camelCase document for the cloud. */
export function rowToDoc(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[snakeToCamel(key)] = value;
  return out;
}

/** Fields that must never leave this machine, per entity type. Cloud rules give
 *  every signed-in business user read access, so secrets stay local. */
const SENSITIVE_DOC_FIELDS: Record<string, string[]> = {
  user: ['passwordHash'],
};

/** Strip local-only secrets from a doc before it is pushed to any transport. */
export function sanitizeDoc(
  entityType: string,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const sensitive = SENSITIVE_DOC_FIELDS[entityType];
  if (!sensitive) return doc;
  const out = { ...doc };
  for (const field of sensitive) delete out[field];
  return out;
}

/** entity_type (as used in sync_queue) -> SQLite table name. */
export const TABLE_FOR_ENTITY: Record<string, string> = {
  user: 'users',
  branch: 'branches',
  product: 'products',
  barcode: 'barcodes',
  inventory: 'inventory',
  till_session: 'till_sessions',
  transaction: 'transactions',
  transaction_item: 'transaction_items',
  stock_movement: 'stock_movements',
  price_history: 'price_history',
};

/** Tables that carry a mutable `sync_status` column (everything except the
 *  append-only ledgers price_history + audit_log). */
export const HAS_SYNC_STATUS = new Set([
  'users',
  'branches',
  'products',
  'barcodes',
  'inventory',
  'till_sessions',
  'transactions',
  'transaction_items',
  'stock_movements',
]);

/** Entities the cloud (head office) may push down to branches (8.2). LWW applies. */
export const PULL_ENTITIES = ['product'];
