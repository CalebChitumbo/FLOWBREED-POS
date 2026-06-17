/**
 * In-memory cloud stand-in for tests/dev. Idempotent by (entityType, id) — pushing
 * the same id twice overwrites identically. Supports simulating offline, per-id
 * push failures, and seeding "cloud" docs for pull/conflict tests.
 */
import type { PushOutcome, SyncPullItem, SyncPushItem, SyncTransport } from './transport';

interface Stored {
  doc: Record<string, unknown> | null;
  updatedAt: string | null;
  deleted: boolean;
}

export class InMemoryTransport implements SyncTransport {
  private readonly store = new Map<string, Map<string, Stored>>();
  private online = true;
  private readonly failIds = new Set<string>();

  isOnline(): boolean {
    return this.online;
  }

  setOnline(value: boolean): void {
    this.online = value;
  }

  failOn(entityId: string): void {
    this.failIds.add(entityId);
  }

  clearFailures(): void {
    this.failIds.clear();
  }

  /** Seed a "cloud" document (e.g. a head-office price change) for pull tests. */
  seed(entityType: string, entityId: string, doc: Record<string, unknown>, updatedAt: string): void {
    this.collection(entityType).set(entityId, { doc, updatedAt, deleted: false });
  }

  getStored(entityType: string, entityId: string): Record<string, unknown> | null | undefined {
    return this.store.get(entityType)?.get(entityId)?.doc;
  }

  private collection(entityType: string): Map<string, Stored> {
    let c = this.store.get(entityType);
    if (!c) {
      c = new Map();
      this.store.set(entityType, c);
    }
    return c;
  }

  async push(items: SyncPushItem[]): Promise<PushOutcome[]> {
    if (!this.online) return items.map((i) => ({ entityId: i.entityId, ok: false, error: 'offline' }));
    return items.map((item) => {
      if (this.failIds.has(item.entityId)) {
        return { entityId: item.entityId, ok: false, error: 'simulated failure' };
      }
      this.collection(item.entityType).set(item.entityId, {
        doc: item.doc,
        updatedAt: item.updatedAt,
        deleted: item.action === 'delete',
      });
      return { entityId: item.entityId, ok: true };
    });
  }

  async pull(entityTypes: string[], since: string | null): Promise<SyncPullItem[]> {
    const out: SyncPullItem[] = [];
    for (const entityType of entityTypes) {
      const c = this.store.get(entityType);
      if (!c) continue;
      for (const [entityId, stored] of c) {
        if (!stored.updatedAt) continue;
        if (!since || stored.updatedAt > since) {
          out.push({ entityType, entityId, doc: stored.doc ?? {}, updatedAt: stored.updatedAt, deleted: stored.deleted });
        }
      }
    }
    return out;
  }
}
