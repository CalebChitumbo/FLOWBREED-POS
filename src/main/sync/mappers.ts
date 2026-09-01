/** Entity <-> sync mapping helpers. */

const snakeToCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Convert a snake_case SQLite row into a camelCase document for the cloud. */
export function rowToDoc(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[snakeToCamel(key)] = value;
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
  order_catalogue_item: 'order_catalogue',
  order_cost_history: 'order_cost_history',
  order_plan: 'order_plans',
  order_plan_item: 'order_plan_items',
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
  'order_catalogue',
  'order_plans',
  'order_plan_items',
]);

/** Entities the cloud (head office) may push down to branches (8.2). LWW applies. */
export const PULL_ENTITIES = ['product'];
