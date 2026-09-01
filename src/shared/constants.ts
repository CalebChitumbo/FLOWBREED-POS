/**
 * Domain constants shared by main + renderer.
 * Kept as `as const` tuples so they double as runtime lists AND literal types.
 */

export const ROLES = ['cashier', 'manager', 'administrator'] as const;
export type Role = (typeof ROLES)[number];

/** Categories appropriate to a butchery + bakery (FM-04). Extensible. */
export const PRODUCT_CATEGORIES = ['Meat', 'Poultry', 'Bakery', 'Beverages', 'Grocery'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Payment methods (FS-05). Extensible without rework. */
export const PAYMENT_METHODS = ['cash', 'mobile_mtn', 'mobile_airtel', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const UNITS_OF_MEASURE = ['each', 'kg', 'g', 'litre'] as const;
export type UnitOfMeasure = (typeof UNITS_OF_MEASURE)[number];

export const STOCK_MOVEMENT_TYPES = ['sale', 'return', 'adjustment', 'stock_in'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const TRANSACTION_TYPES = ['sale', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['completed', 'voided', 'held'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const SYNC_STATUSES = ['pending', 'synced', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** How an item is bought from the supplier (order planning). Extensible. */
export const ORDER_UNITS = ['each', 'kg', 'box', 'crate', 'bag', 'tray', 'litre'] as const;
export type OrderUnit = (typeof ORDER_UNITS)[number];

/**
 * Order plan lifecycle: draft (still planning) -> shopping (cash taken, buying)
 * -> closed (reconciled; a permanent record). `cancelled` is the abandoned end state.
 */
export const ORDER_PLAN_STATUSES = ['draft', 'shopping', 'closed', 'cancelled'] as const;
export type OrderPlanStatus = (typeof ORDER_PLAN_STATUSES)[number];

/** A plan in one of these states is a permanent record and can no longer be edited. */
export const FINAL_ORDER_PLAN_STATUSES: readonly OrderPlanStatus[] = ['closed', 'cancelled'];

/**
 * Zambian Kwacha. All money is stored as INTEGER minor units (ngwee), never floats.
 * 1 Kwacha = 100 ngwee.
 */
export const CURRENCY = {
  code: 'ZMW',
  symbol: 'K',
  minorPerMajor: 100,
} as const;

/** Default configuration keys (see app_config table). */
export const CONFIG_KEYS = {
  branchId: 'branch.id',
  branchName: 'branch.name',
  lockTimeoutMs: 'security.lockTimeoutMs',
  lowStockDefault: 'inventory.lowStockDefault',
  printerName: 'printer.name',
  printerMode: 'printer.mode',
  syncIntervalMs: 'sync.intervalMs',
  receiptHeader: 'receipt.header',
} as const;
