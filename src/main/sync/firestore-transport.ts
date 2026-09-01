/**
 * The real cloud transport (M10). Pushes the outbox into Firestore collections
 * prefixed `pos_` (one per entity type, doc id = the row's client UUID, so a
 * re-push overwrites identically) and pulls the pull-capable entities back down
 * for multi-branch LWW. Lives in the SAME Firebase project as the Flowbreeds
 * Financial app — the `pos_` prefix keeps the raw POS archive cleanly apart
 * from the Financial app's own collections (products, shopSales, ...), which
 * the FinancialBridge speaks to instead.
 *
 * No Electron imports; takes a ready Firestore handle so it stays testable.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { PushOutcome, SyncPullItem, SyncPushItem, SyncTransport } from './transport';

export const POS_COLLECTION_PREFIX = 'pos_';

const PROBE_CACHE_MS = 25_000;
const PROBE_TIMEOUT_MS = 6_000;
const PULL_LIMIT = 500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class FirestoreTransport implements SyncTransport {
  private probeAt = 0;
  private probeResult = false;

  constructor(private readonly firestore: Firestore) {}

  /** Cheap cached reachability probe — one tiny doc read per ~25s at most. */
  async isOnline(): Promise<boolean> {
    const now = Date.now();
    if (now - this.probeAt < PROBE_CACHE_MS) return this.probeResult;
    this.probeAt = now;
    try {
      await withTimeout(
        this.firestore.collection(`${POS_COLLECTION_PREFIX}meta`).doc('heartbeat').get(),
        PROBE_TIMEOUT_MS,
      );
      this.probeResult = true;
    } catch {
      this.probeResult = false;
    }
    return this.probeResult;
  }

  async push(items: SyncPushItem[]): Promise<PushOutcome[]> {
    return Promise.all(
      items.map(async (item): Promise<PushOutcome> => {
        try {
          const ref = this.firestore
            .collection(POS_COLLECTION_PREFIX + item.entityType)
            .doc(item.entityId);
          const updatedAt = item.updatedAt ?? new Date().toISOString();
          if (item.action === 'delete') {
            // Tombstone rather than hard delete, so pulls see the deletion.
            await ref.set({ _deleted: true, updatedAt }, { merge: true });
          } else {
            await ref.set({ ...(item.doc ?? {}), _deleted: false, updatedAt });
          }
          return { entityId: item.entityId, ok: true };
        } catch (err) {
          return {
            entityId: item.entityId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async pull(entityTypes: string[], since: string | null): Promise<SyncPullItem[]> {
    const out: SyncPullItem[] = [];
    for (const entityType of entityTypes) {
      // Single-field range on updatedAt — needs no composite Firestore index.
      let query = this.firestore
        .collection(POS_COLLECTION_PREFIX + entityType)
        .orderBy('updatedAt')
        .limit(PULL_LIMIT);
      if (since) query = query.where('updatedAt', '>', since);
      const snapshot = await query.get();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
        if (!updatedAt) continue;
        out.push({
          entityType,
          entityId: doc.id,
          doc: data,
          updatedAt,
          deleted: data._deleted === true,
        });
      }
    }
    return out;
  }
}
