/**
 * Sync engine (NF/NR). Drains the transactional outbox to a SyncTransport, pulls
 * head-office catalogue changes, and reports online/offline + pending count. Never
 * blocks the till — it runs on a timer in MAIN, off the UI thread.
 *
 * Guarantees:
 *  - Idempotent: each row is pushed under its client UUID; re-push overwrites.
 *  - Push-only ledgers (transactions, items, movements, sessions, price_history)
 *    are archived; pull-capable entities (products) resolve by Last-Write-Wins
 *    on updated_at.
 *  - Retries with exponential backoff; gives up to `failed` after MAX_RETRIES.
 * No Electron imports here, so it is fully unit-testable in Node.
 */
import type { DB } from '../db/connection';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import type { ConfigService } from '../services/config-service';
import type { SyncPullItem, SyncPushItem, SyncTransport } from './transport';
import { HAS_SYNC_STATUS, PULL_ENTITIES, TABLE_FOR_ENTITY, rowToDoc } from './mappers';

export interface SyncStatus {
  online: boolean;
  pending: number;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_RETRIES = 8;
const BATCH = 100;
const LAST_PULL_KEY = 'sync.lastPull';

interface QueueRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: 'create' | 'update' | 'delete';
  payload: string;
  status: string;
  retry_count: number;
  updated_at: string;
}

function backoffMs(retry: number): number {
  if (retry <= 0) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (retry - 1));
}

export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DB,
    private readonly transport: SyncTransport,
    private readonly config: ConfigService,
    private readonly onStatus?: (status: SyncStatus) => void,
  ) {}

  pendingCount(): number {
    return (
      this.db.prepare("SELECT count(*) AS c FROM sync_queue WHERE status = 'pending'").get() as { c: number }
    ).c;
  }

  status(): SyncStatus {
    return { online: Boolean(this.transport.isOnline()), pending: this.pendingCount() };
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<SyncStatus> {
    const online = await this.transport.isOnline();
    if (online) {
      await this.pushPending();
      await this.pullUpdates();
    }
    const status: SyncStatus = { online, pending: this.pendingCount() };
    this.onStatus?.(status);
    return status;
  }

  // ---- push ----

  private eligibleRows(): QueueRow[] {
    const rows = this.db
      .prepare("SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at LIMIT ?")
      .all(BATCH) as QueueRow[];
    const now = Date.now();
    return rows.filter((r) => now - Date.parse(r.updated_at) >= backoffMs(r.retry_count));
  }

  private buildPushItem(row: QueueRow): SyncPushItem {
    if (row.action === 'delete') {
      return { entityType: row.entity_type, entityId: row.entity_id, action: 'delete', doc: null, updatedAt: row.updated_at };
    }
    const table = TABLE_FOR_ENTITY[row.entity_type];
    const current = table
      ? (this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.entity_id) as Record<string, unknown> | undefined)
      : undefined;
    const doc = current ? rowToDoc(current) : (JSON.parse(row.payload) as Record<string, unknown>);
    const updatedAt = (doc.updatedAt as string) ?? (doc.datetime as string) ?? row.updated_at;
    return { entityType: row.entity_type, entityId: row.entity_id, action: row.action, doc, updatedAt };
  }

  async pushPending(): Promise<void> {
    const rows = this.eligibleRows();
    if (rows.length === 0) return;
    const items = rows.map((r) => this.buildPushItem(r));
    const outcomes = await this.transport.push(items);
    const now = nowIso();

    this.db.transaction(() => {
      rows.forEach((row, i) => {
        const outcome = outcomes[i];
        if (outcome?.ok) {
          this.db.prepare("UPDATE sync_queue SET status = 'synced', updated_at = ? WHERE id = ?").run(now, row.id);
          const table = TABLE_FOR_ENTITY[row.entity_type];
          if (row.action !== 'delete' && table && HAS_SYNC_STATUS.has(table)) {
            this.db.prepare(`UPDATE ${table} SET sync_status = 'synced' WHERE id = ?`).run(row.entity_id);
          }
        } else {
          const retry = row.retry_count + 1;
          const status = retry >= MAX_RETRIES ? 'failed' : 'pending';
          this.db
            .prepare('UPDATE sync_queue SET retry_count = ?, last_error = ?, status = ?, updated_at = ? WHERE id = ?')
            .run(retry, outcome?.error ?? 'unknown', status, now, row.id);
        }
      });
    })();
  }

  // ---- pull (head-office -> branch, LWW) ----

  async pullUpdates(): Promise<void> {
    const since = this.config.get(LAST_PULL_KEY);
    const items = await this.transport.pull(PULL_ENTITIES, since);
    if (items.length === 0) return;
    let maxUpdated = since;
    for (const item of items) {
      this.applyPull(item);
      if (!maxUpdated || item.updatedAt > maxUpdated) maxUpdated = item.updatedAt;
    }
    if (maxUpdated) this.config.set(LAST_PULL_KEY, maxUpdated);
  }

  private applyPull(item: SyncPullItem): void {
    if (item.entityType === 'product') this.applyProductPull(item);
  }

  private applyProductPull(item: SyncPullItem): void {
    const id = item.entityId;
    const local = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    // Last-Write-Wins: keep local if it is newer or equal.
    if (local && String(local.updated_at) >= item.updatedAt) return;
    const now = item.updatedAt;
    const d = item.doc;

    this.db.transaction(() => {
      if (item.deleted) {
        if (local) {
          this.db
            .prepare("UPDATE products SET active = 0, updated_at = ?, sync_status = 'synced' WHERE id = ?")
            .run(now, id);
        }
        return;
      }
      const name = String(d.name ?? local?.name ?? '');
      const category = String(d.category ?? local?.category ?? '');
      const unitPrice = Number(d.unitPrice ?? local?.unit_price ?? 0);
      const unitOfMeasure = String(d.unitOfMeasure ?? local?.unit_of_measure ?? 'each');
      const isWeightBased = (d.isWeightBased ?? local?.is_weight_based) ? 1 : 0;
      const lowStock = Number(d.lowStockThreshold ?? local?.low_stock_threshold ?? 0);
      const active = (d.active ?? local?.active ?? 1) ? 1 : 0;
      const createdAt = String(d.createdAt ?? local?.created_at ?? now);

      if (local) {
        if (unitPrice !== Number(local.unit_price)) {
          this.db
            .prepare(
              `INSERT INTO price_history (id, product_id, old_price, new_price, changed_by, datetime)
               VALUES (?, ?, ?, ?, 'cloud:headoffice', ?)`,
            )
            .run(newId(), id, Number(local.unit_price), unitPrice, now);
        }
        this.db
          .prepare(
            `UPDATE products SET name = ?, category = ?, unit_price = ?, unit_of_measure = ?,
               is_weight_based = ?, low_stock_threshold = ?, active = ?, updated_at = ?, sync_status = 'synced'
             WHERE id = ?`,
          )
          .run(name, category, unitPrice, unitOfMeasure, isWeightBased, lowStock, active, now, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO products
               (id, name, category, unit_price, unit_of_measure, is_weight_based, low_stock_threshold, active, created_at, updated_at, sync_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
          )
          .run(id, name, category, unitPrice, unitOfMeasure, isWeightBased, lowStock, active, createdAt, now);
      }
    })();
  }
}
