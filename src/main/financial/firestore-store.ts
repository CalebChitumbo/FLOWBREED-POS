/**
 * FinancialStore implemented over the Flowbreeds Financial app's own Firestore
 * collections (shops, products, stockMovements, shopSales — see APP_SPEC §4).
 * Reads are incremental on the app's ISO `updatedAt` write stamps where a mark
 * exists (single-field range: no composite indexes needed); a null mark does one
 * full scan so pre-stamp legacy docs are still picked up on the first run.
 *
 * No Electron imports; takes a ready Firestore handle so it stays testable.
 */
import type { Firestore, Query } from 'firebase-admin/firestore';
import type {
  FinancialProductDoc,
  FinancialShopDoc,
  FinancialShopSaleDoc,
  FinancialStockMovementDoc,
  FinancialStore,
} from './types';

const LIST_LIMIT = 2000;

export class FirestoreFinancialStore implements FinancialStore {
  constructor(private readonly firestore: Firestore) {}

  private async listSince<T>(collection: string, sinceUpdatedAt: string | null): Promise<(T & { id: string })[]> {
    let query: Query = this.firestore.collection(collection).limit(LIST_LIMIT);
    if (sinceUpdatedAt) {
      query = query.where('updatedAt', '>', sinceUpdatedAt).orderBy('updatedAt');
    }
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ ...(doc.data() as T), id: doc.id }));
  }

  async listShops(): Promise<(FinancialShopDoc & { id: string })[]> {
    const snapshot = await this.firestore.collection('shops').get();
    return snapshot.docs.map((doc) => ({ ...(doc.data() as FinancialShopDoc), id: doc.id }));
  }

  listProducts(sinceUpdatedAt: string | null): Promise<(FinancialProductDoc & { id: string })[]> {
    return this.listSince<FinancialProductDoc>('products', sinceUpdatedAt);
  }

  listStockMovements(
    sinceUpdatedAt: string | null,
  ): Promise<(FinancialStockMovementDoc & { id: string })[]> {
    return this.listSince<FinancialStockMovementDoc>('stockMovements', sinceUpdatedAt);
  }

  /** Full overwrite of the day's doc, but the first push's createdAt survives —
   *  the Financial app treats createdAt as "when this day was first entered". */
  async upsertShopSale(docId: string, doc: FinancialShopSaleDoc): Promise<void> {
    const ref = this.firestore.collection('shopSales').doc(docId);
    await this.firestore.runTransaction(async (txn) => {
      const existing = await txn.get(ref);
      const createdAt = existing.exists
        ? ((existing.data()?.createdAt as string | undefined) ?? doc.createdAt)
        : doc.createdAt;
      txn.set(ref, { ...doc, createdAt });
    });
  }

  async upsertStockMovement(docId: string, doc: FinancialStockMovementDoc): Promise<void> {
    await this.firestore.collection('stockMovements').doc(docId).set(doc);
  }
}
