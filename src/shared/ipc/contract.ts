/**
 * THE single IPC contract.
 *
 * `IpcContract` maps every `domain:action` channel to its `{ request, response }`
 * types. The main handler registry, the preload bridge, and the renderer client
 * are all derived from this one map so a call and its handler can never drift.
 *
 * `IpcEvents` maps main -> renderer push channels (`event:*`).
 *
 * As channels are added per milestone, extend `IpcContract` AND the runtime
 * `IPC_CHANNELS` allow-list below (the type map is erased at runtime; the preload
 * needs a concrete list to validate against).
 */

import type { Role, PaymentMethod, OrderPlanStatus } from '../constants';
import type {
  User,
  Product,
  Barcode,
  PriceHistoryEntry,
  TillSession,
  TillSessionTotals,
  Transaction,
  InventoryLevelView,
  Branch,
  OrderCatalogueItem,
  OrderCostHistoryEntry,
  OrderPlan,
} from '../types/domain';
import type { ReceiptData } from '../types/receipt';
import type { SalesReport, StockMovementView, TransactionFilter } from '../types/report';
import type { StockMovementType } from '../constants';

/** An open session enriched with the cashier's name (manager overview). */
export interface OpenSessionView extends TillSession {
  cashierName: string;
}

export interface SyncStatus {
  online: boolean;
  pending: number;
}

export interface SaleItemPayload {
  productId: string;
  quantity: number;
  lineDiscount?: number;
}

export interface CreateSalePayload {
  items: SaleItemPayload[];
  paymentMethod: PaymentMethod;
  tendered?: number;
  transactionDiscount?: number;
  authorisedBy?: string;
}

export interface RefundPayload {
  originalTxnId: string;
  items: { productId: string; quantity: number }[];
}

export interface SaleResultPayload {
  transaction: Transaction;
  receipt: ReceiptData;
}

export interface ProductInput {
  name: string;
  category: string;
  unitPrice: number;
  unitOfMeasure: string;
  isWeightBased?: boolean;
  lowStockThreshold?: number;
  barcodes?: { barcode: string; packLabel?: string | null }[];
}

export interface ProductPatch {
  name?: string;
  category?: string;
  unitPrice?: number;
  unitOfMeasure?: string;
  isWeightBased?: boolean;
  lowStockThreshold?: number;
  active?: boolean;
}

// ---- Order planning (M11) ----

export interface OrderCatalogueInput {
  code: string;
  name: string;
  supplier?: string | null;
  unitOfOrder: string;
  unitCost: number; // minor units per unit of order
  packSize?: number | null;
  productId?: string | null;
  notes?: string | null;
}

export interface OrderCataloguePatch {
  code?: string;
  name?: string;
  supplier?: string | null;
  unitOfOrder?: string;
  unitCost?: number;
  packSize?: number | null;
  productId?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface OrderPlanInput {
  title: string;
  budget?: number | null;
  notes?: string | null;
}

export interface OrderPlanPatch {
  title?: string;
  budget?: number | null;
  notes?: string | null;
}

export interface OrderLineInput {
  /** The code typed by the buyer, e.g. "BF01". */
  code?: string;
  catalogueId?: string;
  quantity: number;
  unitCost?: number;
  name?: string;
  unitOfOrder?: string;
  notes?: string | null;
  /** One-off line: no order-list lookup; `name` and `unitCost` are required. */
  adHoc?: boolean;
}

/** `undefined` leaves a field alone; `null` clears it. */
export interface OrderLinePatch {
  quantity?: number;
  unitCost?: number;
  actualQuantity?: number | null;
  actualUnitCost?: number | null;
  notes?: string | null;
}

export interface OrderCloseInput {
  budget?: number | null;
  actualTotal?: number;
  notes?: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  schemaVersion: number;
  /** process.platform value, e.g. "win32" | "linux" | "darwin". */
  platform: string;
}

export interface DbPing {
  ok: true;
  tables: number;
}

export interface LoginResult {
  token: string;
  user: User;
}

type Ok = { ok: true };

export interface IpcContract {
  'app:info': { request: void; response: AppInfo };
  'db:ping': { request: void; response: DbPing };

  // ---- Auth (M1) ----
  'auth:bootstrapStatus': { request: void; response: { needsSetup: boolean } };
  'auth:bootstrapAdmin': { request: { username: string; password: string }; response: LoginResult };
  'auth:login': { request: { username: string; password: string }; response: LoginResult };
  'auth:logout': { request: { token: string }; response: Ok };
  'auth:current': { request: { token: string }; response: { user: User } };
  'auth:unlock': { request: { token: string; password: string }; response: Ok };
  'auth:changePassword': {
    request: { token: string; oldPassword: string; newPassword: string };
    response: Ok;
  };
  'auth:authorizeManager': {
    request: { token: string; username: string; password: string };
    response: { userId: string; username: string };
  };

  // ---- Till sessions (M3/M5) ----
  'session:open': { request: { token: string; openingFloat: number }; response: TillSession };
  'session:current': { request: { token: string }; response: TillSession | null };
  'session:close': { request: { token: string; sessionId?: string }; response: TillSession };
  'session:listOpen': { request: { token: string }; response: OpenSessionView[] };
  'session:summary': { request: { token: string; sessionId: string }; response: TillSessionTotals };

  // ---- Sales / checkout (M3) ----
  'sale:create': { request: { token: string; input: CreateSalePayload }; response: SaleResultPayload };
  'sale:refund': { request: { token: string; input: RefundPayload }; response: SaleResultPayload };
  'sale:get': { request: { token: string; id: string }; response: Transaction };
  'print:receipt': { request: { token: string; transactionId: string }; response: Ok };
  'print:reprintLast': { request: { token: string }; response: Ok };

  // ---- Users (M1, administrator only) ----
  'users:list': { request: { token: string }; response: User[] };
  'users:create': {
    request: { token: string; username: string; password: string; role: Role };
    response: User;
  };
  'users:update': {
    request: { token: string; id: string; role?: Role; active?: boolean };
    response: User;
  };
  'users:resetPassword': { request: { token: string; id: string; newPassword: string }; response: Ok };

  // ---- Products (M2) ----
  // search + findByBarcode are available to any authenticated user (checkout);
  // the rest require manager/administrator.
  'product:search': { request: { token: string; query: string }; response: Product[] };
  'product:findByBarcode': { request: { token: string; barcode: string }; response: Product | null };
  'product:list': { request: { token: string; includeInactive?: boolean }; response: Product[] };
  'product:get': { request: { token: string; id: string }; response: Product };
  'product:create': { request: { token: string; input: ProductInput }; response: Product };
  'product:update': { request: { token: string; id: string; patch: ProductPatch }; response: Product };
  'product:addBarcode': {
    request: { token: string; productId: string; barcode: string; packLabel?: string | null };
    response: Barcode;
  };
  'product:removeBarcode': { request: { token: string; barcodeId: string }; response: Ok };
  'product:priceHistory': { request: { token: string; productId: string }; response: PriceHistoryEntry[] };

  // ---- Inventory (M4, manager/administrator) ----
  'inventory:levels': { request: { token: string }; response: InventoryLevelView[] };
  'inventory:lowStock': { request: { token: string }; response: InventoryLevelView[] };
  'inventory:stockIn': {
    request: { token: string; productId: string; quantity: number; notes?: string | null };
    response: Ok;
  };
  'inventory:adjust': {
    request: { token: string; productId: string; newQuantity: number; reason: string; notes?: string | null };
    response: Ok;
  };

  // ---- Reports (M6, manager/administrator) ----
  'report:sales': { request: { token: string; start: string; end: string }; response: SalesReport };
  'report:transactions': { request: { token: string; filter: TransactionFilter }; response: Transaction[] };
  'report:stockMovements': {
    request: {
      token: string;
      start?: string;
      end?: string;
      type?: StockMovementType;
      limit?: number;
    };
    response: StockMovementView[];
  };

  // ---- Order planning (M11, manager/administrator) ----
  // The order price list: preset purchase costs, each under a short code.
  'order:catalogueList': { request: { token: string; includeInactive?: boolean }; response: OrderCatalogueItem[] };
  'order:catalogueSearch': { request: { token: string; query: string }; response: OrderCatalogueItem[] };
  'order:catalogueFindByCode': { request: { token: string; code: string }; response: OrderCatalogueItem | null };
  'order:catalogueCreate': { request: { token: string; input: OrderCatalogueInput }; response: OrderCatalogueItem };
  'order:catalogueUpdate': {
    request: { token: string; id: string; patch: OrderCataloguePatch };
    response: OrderCatalogueItem;
  };
  'order:costHistory': { request: { token: string; catalogueId: string }; response: OrderCostHistoryEntry[] };
  // Order plans: the budget / shopping list and its reconciliation.
  'order:planList': {
    request: { token: string; status?: OrderPlanStatus; limit?: number };
    response: OrderPlan[];
  };
  'order:planGet': { request: { token: string; id: string }; response: OrderPlan };
  'order:planCreate': { request: { token: string; input: OrderPlanInput }; response: OrderPlan };
  'order:planUpdate': { request: { token: string; id: string; patch: OrderPlanPatch }; response: OrderPlan };
  'order:planAddLine': { request: { token: string; planId: string; input: OrderLineInput }; response: OrderPlan };
  'order:planUpdateLine': {
    request: { token: string; lineId: string; patch: OrderLinePatch };
    response: OrderPlan;
  };
  'order:planRemoveLine': { request: { token: string; lineId: string }; response: OrderPlan };
  'order:planSetStatus': {
    request: { token: string; id: string; status: 'draft' | 'shopping' | 'cancelled' };
    response: OrderPlan;
  };
  'order:planClose': { request: { token: string; id: string; input: OrderCloseInput }; response: OrderPlan };
  'order:planDuplicate': { request: { token: string; id: string; title?: string }; response: OrderPlan };

  // ---- Sync (M7) ----
  'sync:status': { request: { token: string }; response: SyncStatus };
  'sync:now': { request: { token: string }; response: SyncStatus };

  // ---- Settings / system (M8) ----
  'config:get': { request: { token: string; keys: string[] }; response: Record<string, string | null> };
  'config:set': { request: { token: string; key: string; value: string }; response: Ok };
  'branch:get': { request: { token: string }; response: Branch };
  'branch:rename': { request: { token: string; name: string }; response: Branch };
  'app:lockTimeout': { request: { token: string }; response: { ms: number } };
  'backup:run': { request: { token: string }; response: { path: string | null } };
  'update:check': { request: { token: string }; response: { available: boolean; version: string | null } };
}

export interface IpcEvents {
  'event:syncStatus': { online: boolean; pending: number };
  'event:lock': { reason: 'inactivity' | 'manual' };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

export type EventChannel = keyof IpcEvents;
export type EventPayload<E extends EventChannel> = IpcEvents[E];

/** Structured error returned to the renderer (NU-02: plain-language messages). */
export interface IpcError {
  code: string;
  message: string;
}

/** Every IPC call resolves to this envelope — never throws across the boundary. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** Runtime allow-list — keep in sync with `IpcContract` keys. */
export const IPC_CHANNELS = [
  'app:info',
  'db:ping',
  'auth:bootstrapStatus',
  'auth:bootstrapAdmin',
  'auth:login',
  'auth:logout',
  'auth:current',
  'auth:unlock',
  'auth:changePassword',
  'auth:authorizeManager',
  'session:open',
  'session:current',
  'session:close',
  'session:listOpen',
  'session:summary',
  'sale:create',
  'sale:refund',
  'sale:get',
  'print:receipt',
  'print:reprintLast',
  'users:list',
  'users:create',
  'users:update',
  'users:resetPassword',
  'product:search',
  'product:findByBarcode',
  'product:list',
  'product:get',
  'product:create',
  'product:update',
  'product:addBarcode',
  'product:removeBarcode',
  'product:priceHistory',
  'inventory:levels',
  'inventory:lowStock',
  'inventory:stockIn',
  'inventory:adjust',
  'report:sales',
  'report:transactions',
  'report:stockMovements',
  'order:catalogueList',
  'order:catalogueSearch',
  'order:catalogueFindByCode',
  'order:catalogueCreate',
  'order:catalogueUpdate',
  'order:costHistory',
  'order:planList',
  'order:planGet',
  'order:planCreate',
  'order:planUpdate',
  'order:planAddLine',
  'order:planUpdateLine',
  'order:planRemoveLine',
  'order:planSetStatus',
  'order:planClose',
  'order:planDuplicate',
  'sync:status',
  'sync:now',
  'config:get',
  'config:set',
  'branch:get',
  'branch:rename',
  'app:lockTimeout',
  'backup:run',
  'update:check',
] as const satisfies readonly IpcChannel[];

/** Runtime allow-list — keep in sync with `IpcEvents` keys. */
export const EVENT_CHANNELS = ['event:syncStatus', 'event:lock'] as const satisfies readonly EventChannel[];

/**
 * Compile-time exhaustiveness guard. `satisfies` above stops a bogus entry
 * getting onto the allow-lists; these stop a channel being ADDED to the contract
 * and forgotten there — which the preload would reject at runtime as BAD_CHANNEL.
 * If one is missing, the error names it.
 */
type Unlisted<Declared extends string, Listed extends string> = Exclude<Declared, Listed>;

export const ALL_CHANNELS_LISTED: Unlisted<IpcChannel, (typeof IPC_CHANNELS)[number]> extends never
  ? true
  : ['channel missing from IPC_CHANNELS:', Unlisted<IpcChannel, (typeof IPC_CHANNELS)[number]>] = true;

export const ALL_EVENTS_LISTED: Unlisted<EventChannel, (typeof EVENT_CHANNELS)[number]> extends never
  ? true
  : ['event missing from EVENT_CHANNELS:', Unlisted<EventChannel, (typeof EVENT_CHANNELS)[number]>] = true;
