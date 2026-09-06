/** In-memory stand-in for the Flowbreeds Financial app's Firestore, mirroring
 *  FirestoreFinancialStore semantics (incremental updatedAt reads, createdAt
 *  preservation on shopSales upserts) so the bridge is testable without Firebase. */
import type {
  FinancialProductDoc,
  FinancialShopDoc,
  FinancialShopSaleDoc,
  FinancialStockMovementDoc,
  FinancialStore,
} from '../../../src/main/financial/types';

export class FakeFinancialStore implements FinancialStore {
  shops: (FinancialShopDoc & { id: string })[] = [];
  products: (FinancialProductDoc & { id: string })[] = [];
  movements: (FinancialStockMovementDoc & { id: string })[] = [];
  readonly shopSales = new Map<string, FinancialShopSaleDoc>();
  readonly stockMovements = new Map<string, FinancialStockMovementDoc>();
  failWrites = false;

  async listShops(): Promise<(FinancialShopDoc & { id: string })[]> {
    return [...this.shops];
  }

  async listProducts(since: string | null): Promise<(FinancialProductDoc & { id: string })[]> {
    return this.products.filter((p) => !since || (p.updatedAt !== undefined && p.updatedAt > since));
  }

  async listStockMovements(
    since: string | null,
  ): Promise<(FinancialStockMovementDoc & { id: string })[]> {
    return this.movements.filter((m) => !since || (m.updatedAt !== undefined && m.updatedAt > since));
  }

  async upsertShopSale(docId: string, doc: FinancialShopSaleDoc): Promise<void> {
    if (this.failWrites) throw new Error('simulated cloud failure');
    const existing = this.shopSales.get(docId);
    this.shopSales.set(docId, { ...doc, createdAt: existing?.createdAt ?? doc.createdAt });
  }

  async upsertStockMovement(docId: string, doc: FinancialStockMovementDoc): Promise<void> {
    if (this.failWrites) throw new Error('simulated cloud failure');
    this.stockMovements.set(docId, doc);
  }
}
