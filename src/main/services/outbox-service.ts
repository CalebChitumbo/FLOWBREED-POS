/**
 * Transactional outbox writer (NF/NR). Services call `enqueue` INSIDE the same
 * SQLite transaction as their domain write, so a row and its sync intent are
 * persisted atomically — nothing is lost or duplicated on crash. The draining
 * loop (SyncEngine) is added in M7; until then these rows simply accumulate as
 * `pending`.
 */
import type { DB } from '../db/connection';
import { newId } from '../util/id';
import { nowIso } from '../util/time';

export type OutboxAction = 'create' | 'update' | 'delete';

export class OutboxService {
  constructor(private readonly db: DB) {}

  enqueue(entityType: string, entityId: string, action: OutboxAction, payload: unknown): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sync_queue (id, entity_type, entity_id, action, payload, status, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(newId(), entityType, entityId, action, JSON.stringify(payload), now, now);
  }
}
