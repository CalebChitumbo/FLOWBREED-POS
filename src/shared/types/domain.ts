/**
 * Domain entity types — the canonical TypeScript shapes for rows that flow across IPC.
 * These mirror the SQLite schema (src/main/db/migrations/001_init.sql) in camelCase.
 * Money fields are INTEGER minor units (ngwee). Timestamps are ISO-8601 UTC strings.
 */
import type {
  Role,
  ProductCategory,
  PaymentMethod,
  UnitOfMeasure,
  StockMovementType,
  TransactionType,
  TransactionStatus,
  SyncStatus,
} from '../constants';

export interface User {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  lastLogin: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Branch {
  id: string;
  name: string;
  details: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  name: string;
  category: ProductCategory | string;
  unitPrice: number; // minor units (per unit, or per kg when weight-based)
  unitOfMeasure: UnitOfMeasure | string;
  isWeightBased: boolean;
  lowStockThreshold: number;
  active: boolean;
  /** Matching product id in the Flowbreeds Financial catalogue (null = not linked). */
  financialId?: string | null;
  createdAt: string;
  updatedAt: string;
  barcodes?: Barcode[];
}

export interface Barcode {
  id: string;
  productId: string;
  barcode: string;
  packLabel: string | null;
  createdAt: string;
}

export interface InventoryLevel {
  id: string;
  productId: string;
  branchId: string;
  quantity: number; // REAL — supports weight
  updatedAt: string;
}

export interface TillSession {
  id: string;
  cashierId: string;
  branchId: string;
  openTime: string;
  closeTime: string | null;
  openingFloat: number;
  status: 'open' | 'closed';
  totals?: TillSessionTotals;
  createdAt: string;
  updatedAt: string;
}

export interface TillSessionTotals {
  totalSales: number;
  totalCash: number;
  totalCard: number;
  totalMobile: number;
  txnCount: number;
  discountTotal: number;
  voidCount: number;
}

export interface Transaction {
  id: string;
  reference: string;
  branchId: string;
  cashierId: string;
  sessionId: string;
  datetime: string;
  type: TransactionType;
  originalTxnId: string | null;
  paymentMethod: PaymentMethod;
  subtotal: number;
  discountTotal: number;
  grandTotal: number;
  tendered: number | null;
  changeDue: number | null;
  status: TransactionStatus;
  authorisedBy: string | null;
  items?: TransactionItem[];
  createdAt: string;
  updatedAt: string;
  syncStatus: SyncStatus;
}

export interface TransactionItem {
  id: string;
  transactionId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceAtSale: number;
  lineDiscount: number;
  lineTotal: number;
  isWeightBased: boolean;
}

export interface StockMovement {
  id: string;
  productId: string;
  branchId: string;
  type: StockMovementType;
  quantity: number; // signed
  reason: string | null;
  referenceId: string | null;
  userId: string;
  datetime: string;
  notes: string | null;
}

export interface PriceHistoryEntry {
  id: string;
  productId: string;
  oldPrice: number;
  newPrice: number;
  changedBy: string;
  datetime: string;
}

export interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  oldValue: string | null;
  newValue: string | null;
  datetime: string;
}

/** A product's current stock at a branch, for the inventory + count-report views. */
export interface InventoryLevelView {
  productId: string;
  name: string;
  category: string;
  unitOfMeasure: string;
  quantity: number;
  lowStockThreshold: number;
  isLow: boolean;
  lastMovement: string | null;
}
