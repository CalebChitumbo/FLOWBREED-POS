/**
 * Document shapes of the Flowbreeds Financial app (the Firebase bookkeeping app,
 * see APP_SPEC §4). These mirror what that app reads and writes in Firestore —
 * money here is ZMW MAJOR units (floats) and dates are local 'YYYY-MM-DD'
 * strings, exactly as the Financial app stores them. Conversion from the POS's
 * ngwee/UTC world happens only in financial/mapping.ts.
 */

export interface FinancialSaleLine {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  priceType: 'order' | 'retail';
  unitPrice: number; // ZMW major units
  amount: number; // ZMW major units
}

/**
 * One shop's takings for one day. The Financial app's own spec shaped this
 * collection for POS terminals: `source: 'POS'` + `terminalId`, summed alongside
 * HQ-entered days everywhere. The POS pushes ONE doc per business day under a
 * deterministic id, so a re-push corrects the day, never duplicates it.
 */
export interface FinancialShopSaleDoc {
  date: string; // 'YYYY-MM-DD' (Africa/Lusaka business day)
  shopId: string;
  lines: FinancialSaleLine[];
  otherSales: number; // ZMW; the POS posts day discounts here as a negative figure
  total: number; // sum(lines.amount) + otherSales == net money taken
  source: 'POS';
  terminalId: string;
  notes: string;
  createdAt: string; // ISO — first push time; the store preserves it across re-pushes
  updatedAt: string; // ISO write stamp (the Financial app's optimistic-concurrency token)
  updatedBy: string; // 'pos:<terminalId>'
}

export interface FinancialProductDoc {
  id: string;
  name: string;
  unit: string;
  orderPrice: number; // ZMW
  retailPrice: number; // ZMW
  shopIds: string[];
  tracksStock: boolean;
  active: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface FinancialShopDoc {
  id: string; // stable slug ('main', 'outlet', ...)
  name: string;
  kind: 'HQ' | 'SHOP' | string;
  location?: string;
  sellsToCustomers?: boolean;
  active: boolean;
  sortOrder?: number;
}

export interface FinancialMovementLine {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
}

export interface FinancialStockMovementDoc {
  date: string; // 'YYYY-MM-DD'
  kind: 'SUPPLY' | 'TRANSFER' | 'ADHOC';
  fromShopId: string | null;
  toShopId: string | null;
  destination: string;
  source: 'HQ Production' | 'Purchase' | 'Other';
  lines: FinancialMovementLine[];
  note: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * The narrow surface of the Financial app's Firestore that the bridge needs.
 * FirestoreFinancialStore implements it with firebase-admin; tests use an
 * in-memory fake, so the whole bridge is unit-testable without Firebase.
 */
export interface FinancialStore {
  listShops(): Promise<(FinancialShopDoc & { id: string })[]>;
  /** Products changed since the ISO stamp; null = everything (first run). */
  listProducts(sinceUpdatedAt: string | null): Promise<(FinancialProductDoc & { id: string })[]>;
  /** Stock movements changed since the ISO stamp; null = everything (first run). */
  listStockMovements(
    sinceUpdatedAt: string | null,
  ): Promise<(FinancialStockMovementDoc & { id: string })[]>;
  /** Full overwrite of the day doc, preserving an existing createdAt. */
  upsertShopSale(docId: string, doc: FinancialShopSaleDoc): Promise<void>;
  /** Idempotent write of a POS-originated movement under a deterministic id. */
  upsertStockMovement(docId: string, doc: FinancialStockMovementDoc): Promise<void>;
}
